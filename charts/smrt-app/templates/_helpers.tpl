{{- define "smrt.labels" -}}
app.kubernetes.io/instance: {{ .Release.Name | quote }}
app.kubernetes.io/name: {{ .Values.app.name | quote }}
smrt.happyvertical.com/environment: {{ .Values.app.environment | quote }}
smrt.happyvertical.com/release: {{ .Values.release.id | quote }}
smrt.happyvertical.com/phase: {{ .Values.release.phase | quote }}
smrt.happyvertical.com/sequence: {{ .Values.release.sequence | quote }}
{{- end }}
{{- define "smrt.container" -}}
{{- $w := .workload }}
- name: runtime
  image: {{ $w.image | quote }}
  imagePullPolicy: IfNotPresent
  command: {{ $w.command | toJson }}
  env: {{ $w.env | toJson }}
  resources: {{ $w.resources | toJson }}
  readinessProbe: {{ $w.readinessProbe | toJson }}
  {{- with $w.startupProbe }}
  startupProbe: {{ . | toJson }}
  {{- end }}
  {{- with $w.livenessProbe }}
  livenessProbe: {{ . | toJson }}
  {{- end }}
  {{- with $w.port }}
  ports: [{name: http, containerPort: {{ . }}}]
  {{- end }}
  {{- with $w.scratch }}
  volumeMounts:
  {{- range . }}
    - name: {{ .name }}
      mountPath: {{ .mountPath | quote }}
  {{- end }}
  {{- end }}
{{- end }}
{{- define "smrt.pod" -}}
automountServiceAccountToken: false
terminationGracePeriodSeconds: {{ .workload.terminationGracePeriodSeconds }}
{{- with .workload.tolerations }}
tolerations: {{ . | toJson }}
{{- end }}
{{- with .workload.nodeSelector }}
nodeSelector: {{ . | toJson }}
{{- end }}
containers:
{{ include "smrt.container" . | indent 2 }}
{{- with .workload.scratch }}
volumes:
{{- range . }}
  - name: {{ .name }}
    emptyDir: {{ omit . "name" "mountPath" | toJson }}
{{- end }}
{{- end }}
{{- end }}

{{- define "smrt.runtimeLabels" -}}
app.kubernetes.io/instance: {{ .root.Release.Name | quote }}
app.kubernetes.io/name: {{ .root.Values.app.name | quote }}
smrt.happyvertical.com/environment: {{ .root.Values.app.environment | quote }}
smrt.happyvertical.com/runtime: {{ .workload | toJson | sha256sum | trunc 63 | quote }}
{{- end }}
