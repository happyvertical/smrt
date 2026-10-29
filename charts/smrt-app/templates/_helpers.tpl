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
  {{- with $w.securityContext }}
  securityContext: {{ . | toJson }}
  {{- end }}
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
  {{- if or $w.scratch $w.readOnlyConfigMaps }}
  volumeMounts:
  {{- range $w.scratch }}
    - name: {{ .name }}
      mountPath: {{ .mountPath | quote }}
  {{- end }}
  {{- range $w.readOnlyConfigMaps }}
    - name: {{ .volumeName }}
      mountPath: {{ .mountPath | quote }}
      readOnly: true
  {{- end }}
  {{- end }}
{{- end }}
{{- define "smrt.pod" -}}
automountServiceAccountToken: false
{{- with .workload.serviceAccountName }}
serviceAccountName: {{ . | quote }}
{{- end }}
{{- with .workload.podSecurityContext }}
securityContext: {{ . | toJson }}
{{- end }}
terminationGracePeriodSeconds: {{ .workload.terminationGracePeriodSeconds }}
{{- with .workload.tolerations }}
tolerations: {{ . | toJson }}
{{- end }}
{{- with .workload.nodeSelector }}
nodeSelector: {{ . | toJson }}
{{- end }}
containers:
{{ include "smrt.container" . | indent 2 }}
{{- if or .workload.scratch .workload.readOnlyConfigMaps }}
volumes:
{{- range .workload.scratch }}
  - name: {{ .name }}
    emptyDir: {{ omit . "name" "mountPath" | toJson }}
{{- end }}
{{- range .workload.readOnlyConfigMaps }}
  - name: {{ .volumeName }}
    configMap:
      name: {{ .configMapName }}
      items: {{ .items | toJson }}
{{- end }}
{{- end }}
{{- end }}

{{- define "smrt.runtimeLabels" -}}
{{- $labels := dict "app.kubernetes.io/instance" .root.Release.Name "app.kubernetes.io/name" .root.Values.app.name "smrt.happyvertical.com/environment" .root.Values.app.environment "smrt.happyvertical.com/runtime" (.workload | toJson | sha256sum | trunc 63) }}
{{- range $key, $value := .workload.selectorLabels }}{{ $_ := set $labels $key $value }}{{ end }}
{{ $labels | toYaml }}
{{- end }}

{{- define "smrt.selectors" -}}
{{- if .workload.selectorLabels -}}
{{ .workload.selectorLabels | toYaml }}
{{- else -}}
app.kubernetes.io/instance: {{ .root.Release.Name | quote }}
smrt.happyvertical.com/workload: {{ .name }}
{{- end -}}
{{- end }}
