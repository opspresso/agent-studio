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

{{/*
The labels every workload of this release shares. On their own they are a
*prefix* of what the bundled PostgreSQL and MinIO pods carry, so nothing may
select on them alone: a selector is a subset match, and the app's Deployment
and Service would claim the database's pods as well. Each workload adds its
own `app.kubernetes.io/component`, and every selector names one.
*/}}
{{- define "agent-studio.selectorLabels" -}}
app.kubernetes.io/name: {{ include "agent-studio.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "agent-studio.appSelectorLabels" -}}
{{ include "agent-studio.selectorLabels" . }}
app.kubernetes.io/component: app
{{- end -}}

{{/*
Images are tagged with the git tag, `v`-prefixed (`release.yml`); the chart's
appVersion is the bare version, as Helm convention has it. The default tag
bridges the two.
*/}}
{{- define "agent-studio.image" -}}
{{- $tag := default (printf "v%s" (trimPrefix "v" .Chart.AppVersion)) .Values.image.tag -}}
{{- printf "%s:%s" .Values.image.repository $tag -}}
{{- end -}}

{{- define "agent-studio.secretName" -}}
{{- default (printf "%s-secrets" (include "agent-studio.fullname" .)) .Values.secrets.existingSecret -}}
{{- end -}}

{{/*
The bundled stores' passwords are the operator's, never generated here. A
chart that minted one would have to read it back on every render to keep it,
and `lookup` answers nothing under `helm template`, `--dry-run` and every
GitOps renderer — each sync would then rewrite the Secret while the data
volume kept the password initdb saw, and the app would be locked out of its
own database. A value the operator set is the same on every render.
*/}}
{{- define "agent-studio.postgresPassword" -}}
{{- required "postgres.password is required when postgres.enabled (openssl rand -hex 24); it is written into the volume at first start and must not change" .Values.postgres.password -}}
{{- end -}}

{{- define "agent-studio.minioPassword" -}}
{{- required "minio.rootPassword is required when minio.enabled (openssl rand -hex 24)" .Values.minio.rootPassword -}}
{{- end -}}
