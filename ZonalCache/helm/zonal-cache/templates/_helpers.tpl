{{- define "zc.fullname" -}}{{ printf "%s" .Release.Name | trunc 63 | trimSuffix "-" }}{{- end -}}
{{- define "zc.labels" -}}
app.kubernetes.io/name: zonal-cache
app.kubernetes.io/instance: {{ .Release.Name }}
zc/zone: {{ .Values.zone | quote }}
{{- end -}}
