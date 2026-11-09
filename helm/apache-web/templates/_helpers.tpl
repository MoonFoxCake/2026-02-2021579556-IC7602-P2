{{- define "apache.fullname" -}}{{ .Release.Name | trunc 63 | trimSuffix "-" }}{{- end -}}
{{- define "apache.labels" -}}
app.kubernetes.io/name: apache-web
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}
