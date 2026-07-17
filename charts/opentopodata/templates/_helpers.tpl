{{- define "opentopodata.name" -}}
{{- default "opentopodata" .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "opentopodata.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name (include "opentopodata.name" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "opentopodata.labels" -}}
app.kubernetes.io/name: {{ include "opentopodata.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}

{{- define "opentopodata.selectorLabels" -}}
app.kubernetes.io/name: {{ include "opentopodata.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "opentopodata.pvcName" -}}
{{- if .Values.data.existingClaim -}}
{{- .Values.data.existingClaim -}}
{{- else -}}
{{- printf "%s-tiles" (include "opentopodata.fullname" .) -}}
{{- end -}}
{{- end -}}
