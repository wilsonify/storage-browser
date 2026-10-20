{{- define "s3-browser.name" -}}
{{- default .Chart.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "s3-browser.fullname" -}}
{{- printf "%s-%s" .Release.Name (include "s3-browser.name" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "s3-browser.labels" -}}
app.kubernetes.io/name: {{ include "s3-browser.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "s3-browser.selectorLabels" -}}
app.kubernetes.io/name: {{ include "s3-browser.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "s3-browser.secretName" -}}
{{- if .Values.aws.existingSecret -}}
{{- .Values.aws.existingSecret -}}
{{- else -}}
{{- printf "%s-aws" (include "s3-browser.fullname" .) -}}
{{- end -}}
{{- end -}}
