{{- define "websocket.fullname" -}}
{{- default "websocket-node" .Values.fullname | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "websocket.selectorLabels" -}}
{{- toYaml .Values.selectorLabels -}}
{{- end -}}

{{- define "websocket.labels" -}}
{{ include "websocket.selectorLabels" . }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}
