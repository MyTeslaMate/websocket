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

{{/*
Pod affinity used to co-locate OTD (and its provisioning Job) with the streaming
forwarder. Shared by the Deployment and the Job so a ReadWriteOnce PVC binds on
— and stays on — the forwarder's node. Renders nothing when colocation.enabled
is false.
*/}}
{{- define "opentopodata.affinity" -}}
{{- if .Values.colocation.enabled -}}
affinity:
  podAffinity:
    {{- if eq .Values.colocation.mode "required" }}
    requiredDuringSchedulingIgnoredDuringExecution:
      - labelSelector:
          matchLabels:
            {{- toYaml .Values.colocation.matchLabels | nindent 12 }}
        topologyKey: {{ .Values.colocation.topologyKey }}
    {{- else }}
    preferredDuringSchedulingIgnoredDuringExecution:
      - weight: {{ .Values.colocation.weight }}
        podAffinityTerm:
          labelSelector:
            matchLabels:
              {{- toYaml .Values.colocation.matchLabels | nindent 14 }}
          topologyKey: {{ .Values.colocation.topologyKey }}
    {{- end }}
{{- end -}}
{{- end -}}
