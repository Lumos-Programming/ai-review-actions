from __future__ import annotations

import asyncio
import json
import logging
import re
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from dataclasses import asdict, dataclass, field, replace
from typing import Annotated, Any

import httpx2
from fastmcp.client.transports import StreamableHttpTransport
from mcp import ClientSession
from pydantic import BaseModel, ConfigDict, Field, HttpUrl, SecretStr, TypeAdapter, field_validator
from pydantic_ai import RunContext
from pydantic_ai.mcp import MCPToolset
from pydantic_ai.toolsets import AbstractToolset, WrapperToolset
from pydantic_ai.toolsets.abstract import ToolsetTool

ServerName = Annotated[str, Field(pattern=r"^[a-z][a-z0-9_]{0,15}$")]
ToolName = Annotated[str, Field(pattern=r"^[a-zA-Z0-9_-]{1,40}$")]


class MCPServerConfig(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    name: ServerName
    url: HttpUrl
    allowed_tools: tuple[ToolName, ...] = Field(min_length=1, max_length=8)
    description: str = Field(min_length=1, max_length=300)

    @field_validator("url")
    @classmethod
    def require_https_endpoint(cls, value: HttpUrl) -> HttpUrl:
        if (
            value.scheme != "https"
            or value.username
            or value.password
            or value.query
            or value.fragment
        ):
            raise ValueError("MCP endpoints must use HTTPS without credentials, query, or fragment")
        return value

    @field_validator("allowed_tools")
    @classmethod
    def unique_tools(cls, value: tuple[str, ...]) -> tuple[str, ...]:
        if len(set(value)) != len(value):
            raise ValueError("MCP allowed_tools must be unique")
        return value


def parse_mcp_settings(
    servers_json: str, headers_json: str
) -> tuple[tuple[MCPServerConfig, ...], dict[str, dict[str, SecretStr]]]:
    """Load trusted Action inputs, without files, subprocesses, or env expansion."""
    try:
        servers = TypeAdapter(
            Annotated[tuple[MCPServerConfig, ...], Field(max_length=4)]
        ).validate_json(servers_json)
        headers = TypeAdapter(dict[ServerName, dict[str, SecretStr]]).validate_json(headers_json)
        names = {server.name for server in servers}
        if len(names) != len(servers) or not headers.keys() <= names:
            raise ValueError("duplicate or unknown server name")
        if sum(len(server.allowed_tools) for server in servers) > 16:
            raise ValueError("too many MCP tools")
        for values in headers.values():
            for name, value in values.items():
                if not re.fullmatch(r"[A-Za-z0-9-]{1,100}", name):
                    raise ValueError("invalid HTTP header name")
                raw = value.get_secret_value()
                if not raw or len(raw) > 8_000 or any(ord(char) < 32 for char in raw):
                    raise ValueError("invalid HTTP header value")
        return servers, headers
    except ValueError:
        # Validation errors can otherwise include the original secret-bearing input.
        raise ValueError(
            "Invalid MCP settings: use up to 4 unique HTTPS servers, explicit allowed_tools "
            "(at most 8 per server, 16 total), and headers keyed by configured server name."
        ) from None


def mcp_http_client(
    headers: dict[str, str] | None = None,
    timeout: httpx2.Timeout | None = None,
    auth: httpx2.Auth | None = None,
    **kwargs: Any,
) -> httpx2.AsyncClient:
    # A redirect must not forward custom API-key headers to another endpoint.
    kwargs["follow_redirects"] = False
    kwargs["trust_env"] = False
    return httpx2.AsyncClient(headers=headers, timeout=timeout or 30, auth=auth, **kwargs)


async def ignore_server_log(_message: Any) -> None:
    # Only bounded, escaped investigation records belong in the Actions log.
    pass


class ReviewMCPTransport(StreamableHttpTransport):
    @asynccontextmanager
    async def connect_session(self, **kwargs: Any) -> AsyncIterator[ClientSession]:
        # The SDK logs raw response bodies and validation tracebacks independently
        # of MCP logging notifications. Keep them out of Actions logs throughout
        # startup, requests, and teardown; the wrapper reports sanitized failures.
        logger = logging.getLogger("mcp.client.streamable_http")

        def ignore_diagnostic(_record: logging.LogRecord) -> bool:
            return False

        logger.addFilter(ignore_diagnostic)
        try:
            async with super().connect_session(**kwargs) as session:
                yield session
        finally:
            logger.removeFilter(ignore_diagnostic)


@dataclass
class ExternalContextToolset(WrapperToolset[None]):
    config: MCPServerConfig
    before_call: Callable[[], None]
    record: Callable[[str, str, str, str, bool], str]
    secrets: tuple[str, ...] = field(default=(), repr=False)

    def redact(self, text: str) -> str:
        for secret in sorted(self.secrets, key=len, reverse=True):
            if secret:
                text = text.replace(secret, "[redacted]")
        return text

    def contains_secret(self, value: Any) -> bool:
        if isinstance(value, str):
            return any(secret and secret in value for secret in self.secrets)
        if isinstance(value, dict):
            return any(
                self.contains_secret(key) or self.contains_secret(item)
                for key, item in value.items()
            )
        if isinstance(value, (list, tuple)):
            return any(self.contains_secret(item) for item in value)
        return False

    async def __aenter__(self) -> ExternalContextToolset:
        try:
            await super().__aenter__()
        except Exception:
            raise RuntimeError(
                f"MCP server {self.config.name} could not connect; "
                "check endpoint and authentication."
            ) from None
        return self

    async def get_tools(self, ctx: RunContext[None]) -> dict[str, ToolsetTool[None]]:
        try:
            available = await super().get_tools(ctx)
        except Exception:
            raise RuntimeError(f"MCP server {self.config.name} could not list tools.") from None
        selected = {}
        for name in self.config.allowed_tools:
            if name not in available:
                raise RuntimeError(f"MCP server {self.config.name} does not provide {name}.")
            tool = available[name]
            if self.contains_secret(asdict(tool.tool_def)):
                # Replacing schema strings could change enum/default/validation
                # semantics. Reject the definition before it reaches the model.
                raise RuntimeError(
                    f"MCP server {self.config.name} returned authentication data "
                    "in a tool definition."
                )
            annotations = (tool.tool_def.metadata or {}).get("annotations") or {}
            if annotations.get("readOnlyHint") is False:
                raise RuntimeError(f"MCP tool {self.config.name}/{name} is marked as writable.")
            selected[name] = replace(
                tool,
                toolset=self,
                tool_def=replace(
                    tool.tool_def,
                    description=self.redact(
                        f"{self.config.description}\n{tool.tool_def.description or ''}"
                    ),
                    sequential=True,
                    timeout=40,
                    return_schema=None,
                ),
            )
        return selected

    async def call_tool(
        self, name: str, tool_args: dict[str, Any], ctx: RunContext[None], tool: ToolsetTool[None]
    ) -> str:
        if name not in self.config.allowed_tools:
            raise ValueError("MCP tool is not allowed")
        self.before_call()
        failed = False
        try:
            async with asyncio.timeout(30):
                result = await super().call_tool(name, tool_args, ctx, tool)
            output = (
                result
                if isinstance(result, str)
                else json.dumps(
                    result, ensure_ascii=False, default=lambda _: "[non-text MCP content omitted]"
                )
            )
        except TimeoutError:
            failed = True
            output = "External context request timed out after 30 seconds."
        except Exception as error:
            failed = True
            output = f"External context request failed: {error}"
        return self.record(
            self.config.name,
            name,
            self.redact(json.dumps(tool_args, ensure_ascii=False)),
            self.redact(output),
            failed,
        )


def build_mcp_toolsets(
    servers: tuple[MCPServerConfig, ...],
    headers: dict[str, dict[str, SecretStr]],
    before_call: Callable[[], None],
    record: Callable[[str, str, str, str, bool], str],
) -> list[AbstractToolset[None]]:
    toolsets: list[AbstractToolset[None]] = []
    for server in servers:
        values = {
            key: value.get_secret_value() for key, value in headers.get(server.name, {}).items()
        }
        public_headers = {"x-mcp-readonly", "x-mcp-tools", "x-mcp-toolsets", "x-mcp-insiders"}
        secrets = tuple(
            secret
            for name, value in values.items()
            if name.lower() not in public_headers
            for secret in (value, value.removeprefix("Bearer "))
        )
        transport = ReviewMCPTransport(
            str(server.url), headers=values, httpx_client_factory=mcp_http_client
        )
        mcp: MCPToolset[None] = MCPToolset(
            transport,
            init_timeout=15,
            read_timeout=30,
            tool_error_behavior="error",
            include_instructions=False,
            log_handler=ignore_server_log,
        )
        toolsets.append(
            ExternalContextToolset(mcp, server, before_call, record, secrets).prefixed(
                f"mcp_{server.name}"
            )
        )
    return toolsets
