#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"
ENV_FILE="$ROOT/ZonalCache/.env"

for tool in minikube kubectl helm docker; do
  command -v "$tool" >/dev/null || { echo "Falta $tool en el PATH" >&2; exit 1; }
done
[[ -f "$ENV_FILE" ]] || { echo "Copie ZonalCache/.env.example a ZonalCache/.env y complete sus valores." >&2; exit 1; }

set -a
# This local file is user-owned and gitignored; never print its values.
. "$ENV_FILE"
set +a
: "${ZC_CONFIG_URL:?Defina ZC_CONFIG_URL en ZonalCache/.env}"
: "${ZC_CONFIG_TOKEN:?Defina ZC_CONFIG_TOKEN en ZonalCache/.env}"
DNS_API_URL=${DNS_API_URL:-$ZC_CONFIG_URL}
NAMESPACE=${NAMESPACE:-default}
TLS_CN=${TLS_CN:-ejemplo.com}
ZC_LOGIN_MODE=${ZC_LOGIN_MODE:-local}
ZC_TICKET_SECRET=${ZC_TICKET_SECRET:-}

if [[ "$ZC_LOGIN_MODE" == "ui" && ${#ZC_TICKET_SECRET} -lt 32 ]]; then
  echo "ZC_LOGIN_MODE=ui requiere ZC_TICKET_SECRET de al menos 32 caracteres." >&2
  exit 1
fi

minikube status >/dev/null 2>&1 || minikube start
kubectl config use-context minikube >/dev/null
kubectl get namespace "$NAMESPACE" >/dev/null 2>&1 || kubectl create namespace "$NAMESPACE"

echo "==> Construyendo y cargando imágenes para Minikube"
docker build -f "$ROOT/Interceptor/dockerfile" -t dns-interceptor:dev "$ROOT/Interceptor"
minikube image load dns-interceptor:dev
minikube image build -t rest-api-java:dev "$ROOT/rest-api-java"
minikube image build -t apache-web:dev "$ROOT/apache-web"

echo "==> Instalando Java REST API y Apache"
helm upgrade --install rest-api-java helm/rest-api-java -n "$NAMESPACE"
helm upgrade --install apache-web helm/apache-web -n "$NAMESPACE"

echo "==> Instalando Zonal Cache por zona"
bash ZonalCache/scripts/deploy-k8s.sh

echo "==> Instalando DNS Interceptor"
helm upgrade --install dns-interceptor helm/dns-interceptor -n "$NAMESPACE" \
  --set image.repository=dns-interceptor --set image.tag=dev \
  --set-string api.url="$DNS_API_URL"

echo "==> Esperando servicios"
kubectl -n "$NAMESPACE" rollout status deploy/rest-api-java --timeout=180s
kubectl -n "$NAMESPACE" rollout status deploy/apache-web --timeout=180s
kubectl -n "$NAMESPACE" rollout status deploy/dns-interceptor --timeout=180s
kubectl -n "$NAMESPACE" get deploy,svc -o wide

CR_IP=$(kubectl -n "$NAMESPACE" get svc zc-cr -o jsonpath='{.status.loadBalancer.ingress[0].ip}')
US_IP=$(kubectl -n "$NAMESPACE" get svc zc-us -o jsonpath='{.status.loadBalancer.ingress[0].ip}')
DNS_IP=$(kubectl -n "$NAMESPACE" get svc dns-interceptor -o jsonpath='{.status.loadBalancer.ingress[0].ip}')
echo
echo "Minikube workloads are installed. Keep the selected LoadBalancer provider available (tunnel or MetalLB, not both)."
if [[ -n "$CR_IP" && -n "$US_IP" && -n "$DNS_IP" ]]; then
  if [[ "$CR_IP" == "$US_IP" || "$CR_IP" == 127.* || "$US_IP" == 127.* || "$DNS_IP" == 127.* ]]; then
    echo "Las zonas necesitan IP distintas y alcanzables; localhost no sirve como destino zonal."
    echo "En WSL configure MetalLB: docs/WSL-DEPLOYMENT.md. No copie estas IP a Vercel."
    exit 1
  fi
  echo "Vercel API setting (save and redeploy): ZONE_CACHES=cr=$CR_IP,us=$US_IP"
  echo "DNS Interceptor address: $DNS_IP"
  echo "Then verify DNS with: nslookup <verified-domain> $DNS_IP"
else
  echo "LoadBalancer addresses are pending. Check the tunnel or MetalLB configuration and run this installer again."
fi
