{{/*
Expand the name of the chart.
*/}}
{{- define "mcp-rest-bridge.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Create a default fully qualified app name, truncated to fit Kubernetes name
limits (63 chars, since it's used as a label/selector value too).
*/}}
{{- define "mcp-rest-bridge.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/*
Common labels.
*/}}
{{- define "mcp-rest-bridge.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{ include "mcp-rest-bridge.selectorLabels" . }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
{{- end -}}

{{/*
Selector labels.
*/}}
{{- define "mcp-rest-bridge.selectorLabels" -}}
app.kubernetes.io/name: {{ include "mcp-rest-bridge.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{/*
Name of the Secret the Deployment should mount — either the chart-templated
one, or an existing operator-managed Secret when `existingSecret` is set.
*/}}
{{- define "mcp-rest-bridge.secretName" -}}
{{- .Values.existingSecret | default (include "mcp-rest-bridge.fullname" .) -}}
{{- end -}}

{{/*
Name of the PVC the Deployment should mount when persistence is enabled —
either an existing operator-managed claim, or the one this chart creates.
*/}}
{{- define "mcp-rest-bridge.pvcName" -}}
{{- .Values.persistence.existingClaim | default (printf "%s-data" (include "mcp-rest-bridge.fullname" .)) -}}
{{- end -}}
