{{- define "agent-studio.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "agent-studio.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s" .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "agent-studio.labels" -}}
app.kubernetes.io/name: {{ include "agent-studio.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}

{{- define "agent-studio.selectorLabels" -}}
app.kubernetes.io/name: {{ include "agent-studio.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "agent-studio.image" -}}
{{- printf "%s:%s" .Values.image.repository (default .Chart.AppVersion .Values.image.tag) -}}
{{- end -}}

{{- define "agent-studio.secretName" -}}
{{- default (printf "%s-secrets" (include "agent-studio.fullname" .)) .Values.secrets.existingSecret -}}
{{- end -}}

{{/*
A value kept across upgrades: the one already in the named Secret when there
is one, else the configured value, else a fresh random string. What makes a
bundled database's password survive `helm upgrade`.
*/}}
{{- define "agent-studio.keep" -}}
{{- $secret := lookup "v1" "Secret" .ns .name -}}
{{- if and $secret (index $secret.data .key) -}}
{{- index $secret.data .key | b64dec -}}
{{- else if .value -}}
{{- .value -}}
{{- else -}}
{{- randAlphaNum 32 -}}
{{- end -}}
{{- end -}}

{{- define "agent-studio.postgresPassword" -}}
{{- include "agent-studio.keep" (dict "ns" .Release.Namespace "name" (printf "%s-postgres" (include "agent-studio.fullname" .)) "key" "POSTGRES_PASSWORD" "value" .Values.postgres.password) -}}
{{- end -}}

{{- define "agent-studio.minioPassword" -}}
{{- include "agent-studio.keep" (dict "ns" .Release.Namespace "name" (printf "%s-minio" (include "agent-studio.fullname" .)) "key" "MINIO_ROOT_PASSWORD" "value" .Values.minio.rootPassword) -}}
{{- end -}}
