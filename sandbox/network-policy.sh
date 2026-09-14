#!/bin/sh
set -eu

# このプロセスだけがNET_ADMINを持つ。調査コンテナの権限は追加しない。
# 外向き通信を先に閉じ、設定が途中で失敗しても公開アクセスを許可しない。
iptables -P OUTPUT DROP
ip6tables -P OUTPUT DROP
iptables -A OUTPUT -o lo -j ACCEPT
ip6tables -A OUTPUT -o lo -j ACCEPT
iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT

# ホスト、プライベート網、メタデータサービス、特殊用途の宛先を拒否する。
for destination in \
    0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 \
    172.16.0.0/12 192.0.0.0/24 192.0.2.0/24 192.168.0.0/16 \
    198.18.0.0/15 198.51.100.0/24 203.0.113.0/24 224.0.0.0/4 240.0.0.0/4
do
    iptables -A OUTPUT -d "$destination" -j REJECT
done

# DNSはDockerのループバックリゾルバー経由。外部へはHTTP(S)だけ許可する。
iptables -A OUTPUT -p tcp -m multiport --dports 80,443 -j ACCEPT
