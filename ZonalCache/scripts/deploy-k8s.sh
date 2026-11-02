#!/usr/bin/env bash
# Despliega la Zonal Cache (una release de Helm por zona) en Kubernetes. Pensado para minikube, sirve en cualquier clúster.
#
#   cp ZonalCache/.env.example ZonalCache/.env   # completar valores
#   bash ZonalCache/scripts/deploy-k8s.sh        # construye la imagen, crea Secrets y hace helm upgrade --install
#
# Variables (desde ZonalCache/.env o exportadas antes de correr):
#   ZC_CONFIG_URL     obligatoria  base del API Node.js (https://<api>.vercel.app)
#   ZC_CONFIG_TOKEN   obligatoria  = SERVICE_KEY configurada en Vercel
#   ZC_TICKET_SECRET  si ZC_LOGIN_MODE=ui (>= 16 caracteres; = TICKET_SECRET del API)
#   ZC_LOGIN_MODE     local | ui (default local)      ZC_LOGIN_UI_URL  https://<ui>.vercel.app/cache-login
#   ZONES             zonas a desplegar (default "cr us"; cada una necesita helm/zonal-cache/values-<zona>.yaml)
#   NAMESPACE         default            IMAGE  zonal-cache:dev      SERVICE_TYPE  LoadBalancer | NodePort
#   TLS_CN            CN del certificado de desarrollo si no existe el Secret zc-tls (default: ejemplo.com)
set -euo pipefail
cd "$(dirname "$0")/.."
if [ -f .env ]; then set -a; . ./.env; set +a; fi

: "${ZC_CONFIG_URL:?Defina ZC_CONFIG_URL (base del API Node.js) en ZonalCache/.env}"
: "${ZC_CONFIG_TOKEN:?Defina ZC_CONFIG_TOKEN (= SERVICE_KEY del API) en ZonalCache/.env}"
ZONES=${ZONES:-"cr us"}; NAMESPACE=${NAMESPACE:-default}; IMAGE=${IMAGE:-zonal-cache:dev}
ZC_LOGIN_MODE=${ZC_LOGIN_MODE:-local}; SERVICE_TYPE=${SERVICE_TYPE:-LoadBalancer}; TLS_CN=${TLS_CN:-ejemplo.com}
REPO=${IMAGE%:*}; TAG=${IMAGE##*:}
for t in kubectl helm; do command -v $t >/dev/null || { echo "Falta $t en el PATH"; exit 1; }; done
if [ "$ZC_LOGIN_MODE" = ui ] && [ ${#ZC_TICKET_SECRET} -lt 16 ]; then echo "ZC_LOGIN_MODE=ui requiere ZC_TICKET_SECRET >= 16"; exit 1; fi

echo "==> 1/4 Imagen $IMAGE"
if command -v minikube >/dev/null && minikube status >/dev/null 2>&1; then
  minikube image build -t "$IMAGE" .            # queda dentro de minikube (imagePullPolicy IfNotPresent)
else
  docker build -t "$IMAGE" .
  echo "    (si el clúster no comparte el daemon de Docker, súbala a un registro y use IMAGE=<registro>/zonal-cache:tag)"
fi

echo "==> 2/4 Secrets en el namespace $NAMESPACE"
kubectl get ns "$NAMESPACE" >/dev/null 2>&1 || kubectl create ns "$NAMESPACE"
kubectl -n "$NAMESPACE" create secret generic zc-secrets \
  --from-literal=ZC_CONFIG_TOKEN="$ZC_CONFIG_TOKEN" \
  --from-literal=ZC_TICKET_SECRET="${ZC_TICKET_SECRET:-}" \
  --dry-run=client -o yaml | kubectl apply -f -
if ! kubectl -n "$NAMESPACE" get secret zc-tls >/dev/null 2>&1; then
  bash scripts/gen-dev-cert.sh ./certs "$TLS_CN" >/dev/null
  kubectl -n "$NAMESPACE" create secret tls zc-tls --cert=certs/dev.crt --key=certs/dev.key
  echo "    certificado autofirmado para $TLS_CN en el Secret zc-tls (use curl -k)"
fi

echo "==> 3/4 Helm: zonas $ZONES"
for z in $ZONES; do
  helm upgrade --install "zc-$z" helm/zonal-cache -n "$NAMESPACE" \
    -f helm/zonal-cache/values.yaml -f "helm/zonal-cache/values-$z.yaml" \
    --set image.repository="$REPO" --set image.tag="$TAG" \
    --set config.url="$ZC_CONFIG_URL" \
    --set login.mode="$ZC_LOGIN_MODE" --set login.uiUrl="${ZC_LOGIN_UI_URL:-}" \
    --set tls.enabled=true --set service.type="$SERVICE_TYPE"
done

echo "==> 4/4 Esperando a que cada zona cargue su configuración (readiness = /__zc/healthz)"
for z in $ZONES; do kubectl -n "$NAMESPACE" rollout status "deploy/zc-$z" --timeout=180s; done
kubectl -n "$NAMESPACE" get svc -l app.kubernetes.io/name=zonal-cache -o wide
cat <<EOF

Listo. Siguientes pasos:
  - minikube: deje "minikube tunnel" corriendo para que cada Service LoadBalancer tenga EXTERNAL-IP.
  - Ponga esas IPs en Vercel (API) como ZONE_CACHES, p.ej.  ZONE_CACHES=cr=<ip zc-cr>,us=<ip zc-us>
    para que el DNS Interceptor devuelva la caché de la zona de cada cliente.
  - Pruebas: ver ZonalCache/docs/COMO-CORRER.md, sección "Probar en Kubernetes".
EOF
