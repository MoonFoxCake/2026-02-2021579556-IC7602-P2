# Apache origin

Apache serves the small HTML page at the root path. The image listens on unprivileged port 8080; its Kubernetes Service exposes port 80.

```bash
docker build -t apache-web:dev .
docker run --rm -p 18081:8080 apache-web:dev
```

In Kubernetes, deploy it with `helm/apache-web`. Full Minikube steps are in [docs/KUBERNETES.md](../docs/KUBERNETES.md).
