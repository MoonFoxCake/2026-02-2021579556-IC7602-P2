{{- define "java.fullname" -}}{{ .Release.Name | trunc 63 | trimSuffix "-" }}{{- end -}}
{{- define "java.labels" -}}
app.kubernetes.io/name: rest-api-java
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}
