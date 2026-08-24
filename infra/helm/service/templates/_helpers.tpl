{{- define "service.fullname" -}}
{{ .Values.name }}
{{- end -}}

{{- define "service.labels" -}}
app.kubernetes.io/name: {{ .Values.name }}
app.kubernetes.io/part-of: digital-democracy
app.kubernetes.io/managed-by: {{ .Release.Service }}
dd.io/lang: {{ .Values.lang }}
{{- end -}}

{{- define "service.selectorLabels" -}}
app.kubernetes.io/name: {{ .Values.name }}
{{- end -}}
