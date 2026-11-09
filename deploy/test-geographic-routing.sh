#!/usr/bin/env bash
# Real UDP clients outside Kubernetes; synthetic source addresses stay inside isolated lab namespaces.
set -euo pipefail
[[ $EUID == 0 ]] || { echo 'Run with sudo/root: network namespaces require it.' >&2; exit 1; }
for TOOL in ip iptables dig curl node; do command -v "$TOOL" >/dev/null; done
: "${P2_API_URL:?Set the HTTPS Node API base URL}"
: "${P2_DNS_IP:?Set the interceptor LoadBalancer IP}"
: "${P2_CR_IP:?Set the CR cache IP}"
: "${P2_US_IP:?Set the US cache IP}"
: "${P2_DOMAIN:?Set a verified domain with a public /index.html rule}"
: "${P2_CR_SOURCE_IP:?Set a DB-IP IPv4 address assigned to CR}"
: "${P2_US_SOURCE_IP:?Set a DB-IP IPv4 address assigned to US}"
[[ "$P2_DOMAIN" =~ ^[a-z0-9.-]+$ && "$P2_API_URL" == https://* ]]
node -e 'if(process.argv.slice(1).some(ip=>!require("node:net").isIPv4(ip)))process.exit(1)' \
  "$P2_DNS_IP" "$P2_CR_IP" "$P2_US_IP" "$P2_CR_SOURCE_IP" "$P2_US_SOURCE_IP"
[[ $(cat /proc/sys/net/ipv4/ip_forward) == 1 ]] || { echo 'IPv4 forwarding must already be enabled.' >&2; exit 1; }
[[ -z $(ip -4 route show exact 198.18.253.0/30) ]] || { echo 'Lab transit subnet already in use.' >&2; exit 1; }
WORK=$(mktemp -d)
NS= HOST= PEER= SOURCE= CACHE=
CREATED_NS=0; CREATED_LINK=0
cleanup_client() {
  if (( CREATED_LINK )); then
    iptables -D FORWARD -i "$HOST" -s "$SOURCE/32" -d "$P2_DNS_IP/32" -p udp --dport 53 -j ACCEPT 2>/dev/null || true
    iptables -D FORWARD -i "$HOST" -s "$SOURCE/32" -d "$CACHE/32" -p tcp --dport 80 -j ACCEPT 2>/dev/null || true
    iptables -D FORWARD -o "$HOST" -d "$SOURCE/32" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT 2>/dev/null || true
    ip link del "$HOST"
    CREATED_LINK=0
  fi
  if (( CREATED_NS )); then ip netns del "$NS"; CREATED_NS=0; fi
}
cleanup() { cleanup_client; rm -rf "$WORK"; }
trap cleanup EXIT
for ZONE in cr us; do
  if [[ "$ZONE" == cr ]]; then SOURCE=$P2_CR_SOURCE_IP; CACHE=$P2_CR_IP; else SOURCE=$P2_US_SOURCE_IP; CACHE=$P2_US_IP; fi
  [[ -z $(ip -4 route show exact "$SOURCE/32") ]] || { echo "An explicit route for $SOURCE already exists." >&2; exit 1; }
  COUNTRY=$(curl -fsS --max-time 20 --get --data-urlencode "sourceIp=$SOURCE" \
    "${P2_API_URL%/}/api/records/$P2_DOMAIN" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).client.country))')
  [[ "$COUNTRY" == "${ZONE^^}" ]] || { echo "DB-IP classified $SOURCE as $COUNTRY, expected ${ZONE^^}." >&2; exit 1; }
  NS="p2geo-$$-$ZONE"; HOST="p2g$$${ZONE}h"; PEER="p2g$$${ZONE}p"
  ip netns add "$NS"; CREATED_NS=1
  ip link add "$HOST" type veth peer name "$PEER"; CREATED_LINK=1
  ip link set "$PEER" netns "$NS"
  ip addr add 198.18.253.1/30 dev "$HOST"; ip link set "$HOST" up
  ip -n "$NS" link set lo up
  ip -n "$NS" addr add 198.18.253.2/30 dev "$PEER"; ip -n "$NS" link set "$PEER" up
  ip -n "$NS" addr add "$SOURCE/32" dev lo
  ip route add "$SOURCE/32" via 198.18.253.2 dev "$HOST"
  # No default route: these test clients can reach only the lab DNS and selected cache.
  for DESTINATION in "$P2_DNS_IP" "$CACHE"; do
    ip -n "$NS" route add "$DESTINATION/32" via 198.18.253.1 dev "$PEER" src "$SOURCE"
  done
  iptables -I FORWARD 1 -i "$HOST" -s "$SOURCE/32" -d "$P2_DNS_IP/32" -p udp --dport 53 -j ACCEPT
  iptables -I FORWARD 1 -i "$HOST" -s "$SOURCE/32" -d "$CACHE/32" -p tcp --dport 80 -j ACCEPT
  iptables -I FORWARD 1 -o "$HOST" -d "$SOURCE/32" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
  ANSWER=$(ip netns exec "$NS" dig +short +time=10 +tries=1 -b "$SOURCE" "@$P2_DNS_IP" "$P2_DOMAIN" A | tail -n 1)
  echo "$ZONE: source=$SOURCE country=$COUNTRY DNS=$ANSWER expected=$CACHE"
  [[ "$ANSWER" == "$CACHE" ]] || { echo 'Geographic DNS/source-IP preservation failed.' >&2; exit 1; }
  RESOURCE="http://$ANSWER/index.html?geo_probe=$(date +%s%N)"
  for EXPECTED in MISS HIT; do
    ip netns exec "$NS" curl --noproxy '*' -fsS --max-time 15 -H "Host: $P2_DOMAIN" \
      -D "$WORK/headers" -o "$WORK/$EXPECTED.body" "$RESOURCE"
    tr -d '\r' < "$WORK/headers" > "$WORK/clean-headers"
    grep -qi "^X-ZC-Zone: $ZONE$" "$WORK/clean-headers"
    grep -qi "^X-Cache: $EXPECTED$" "$WORK/clean-headers"
    echo "PASS $ZONE: DNS-selected cache returned HTTP 200 / $EXPECTED"
  done
  cmp "$WORK/MISS.body" "$WORK/HIT.body"
  cleanup_client
done
echo 'PASS: original source countries, geographic DNS, selected cache and disk MISS/HIT in both zones.'
