{{- define "dns.fullname" -}}{{ .Release.Name | trunc 63 | trimSuffix "-" }}{{- end -}}
{{- define "dns.labels" -}}
app.kubernetes.io/name: dns-interceptor
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}
