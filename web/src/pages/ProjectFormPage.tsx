import { FormEvent, useEffect, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api } from '../api/client'
import type { ProjectInput, ProjectUpdateInput, SigningMode } from '../types'
import { firstZodError, parseTesterGroups, projectFormSchema, type ProjectFormValues } from '../lib/validation'
import { ErrorState, FieldError, LoadingState, PageHeader } from '../components/ui'

function envReferenceOrUndefined(value: string | undefined): string | undefined {
  return value && /^[A-Z][A-Z0-9_]*$/.test(value) ? value : undefined
}

const emptyProject: ProjectFormValues = {
  projectKey: '', displayName: '', repoPath: '', fastlaneLane: 'distribute', scheme: undefined,
  buildConfiguration: 'Debug', firebaseAppId: '', firebaseTesterGroupsText: '',
  firebaseCliTokenEnvVar: 'FIREBASE_CLI_TOKEN', matchPasswordEnvVar: 'MATCH_PASSWORD',
  appStoreConnectKeyIdEnvVar: undefined, appStoreConnectIssuerIdEnvVar: undefined,
  appStoreConnectKeyPathEnvVar: undefined, signingMode: 'match', appleTeamId: undefined,
  signingCertificate: 'Apple Distribution', provisioningProfiles: [], larkNotificationChatId: undefined,
  enabled: false, version: undefined,
}

export function ProjectFormPage() {
  const { projectKey } = useParams()
  const editing = Boolean(projectKey)
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [values, setValues] = useState<ProjectFormValues>(emptyProject)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const project = useQuery({ queryKey: ['projects', projectKey], queryFn: () => api.getProject(projectKey!), enabled: editing })

  useEffect(() => {
    if (!project.data) return
    const data = project.data
    setValues({
      projectKey: data.projectKey, displayName: data.displayName, repoPath: data.repoPath,
      fastlaneLane: data.fastlaneLane, scheme: data.scheme ?? undefined,
      buildConfiguration: data.buildConfiguration ?? undefined, firebaseAppId: data.firebaseAppId,
      firebaseTesterGroupsText: data.firebaseTesterGroups.join(', '), firebaseCliTokenEnvVar: data.firebaseCliTokenEnvVar,
      matchPasswordEnvVar: data.matchPasswordEnvVar ?? undefined, appStoreConnectKeyIdEnvVar: data.appStoreConnectKeyIdEnvVar ?? undefined,
      appStoreConnectIssuerIdEnvVar: data.appStoreConnectIssuerIdEnvVar ?? undefined, appStoreConnectKeyPathEnvVar: data.appStoreConnectKeyPathEnvVar ?? undefined,
      signingMode: data.signingMode, appleTeamId: data.appleTeamId ?? undefined,
      signingCertificate: data.signingCertificate, provisioningProfiles: data.provisioningProfiles,
      larkNotificationChatId: data.larkNotificationChatId ?? undefined,
      enabled: data.enabled, version: data.version,
    })
  }, [project.data])

  const save = useMutation({
    mutationFn: async (form: ProjectFormValues) => {
      const provisioningProfiles = form.provisioningProfiles.filter((profile) => profile.bundleId && profile.profileName)
      const base: ProjectInput = {
        projectKey: form.projectKey, displayName: form.displayName, repoPath: form.repoPath,
        fastlaneLane: form.fastlaneLane, scheme: form.scheme, buildConfiguration: form.buildConfiguration ?? null,
        firebaseAppId: form.firebaseAppId, firebaseTesterGroups: parseTesterGroups(form.firebaseTesterGroupsText),
        firebaseCliTokenEnvVar: form.firebaseCliTokenEnvVar, matchPasswordEnvVar: envReferenceOrUndefined(form.matchPasswordEnvVar),
        appStoreConnectKeyIdEnvVar: envReferenceOrUndefined(form.appStoreConnectKeyIdEnvVar), appStoreConnectIssuerIdEnvVar: envReferenceOrUndefined(form.appStoreConnectIssuerIdEnvVar),
        appStoreConnectKeyPathEnvVar: envReferenceOrUndefined(form.appStoreConnectKeyPathEnvVar), signingMode: form.signingMode,
        appleTeamId: form.appleTeamId, signingCertificate: form.signingCertificate,
        provisioningProfiles, larkNotificationChatId: form.larkNotificationChatId,
        enabled: form.enabled,
      }
      if (!editing) return api.createProject(base)
      const { projectKey: _projectKey, ...updateFields } = base
      const update: ProjectUpdateInput = { ...updateFields, version: form.version! }
      return api.updateProject(projectKey!, update)
    },
    onSuccess: async (saved) => { await queryClient.invalidateQueries({ queryKey: ['projects'] }); navigate(`/projects/${saved.projectKey}`, { replace: true }) },
  })

  function update<K extends keyof ProjectFormValues>(key: K, value: ProjectFormValues[K]) {
    setValues((current) => ({ ...current, [key]: value })); setErrors((current) => ({ ...current, [key]: '' }))
  }
  function setSigningMode(signingMode: SigningMode) {
    setValues((current) => ({
      ...current,
      signingMode,
      provisioningProfiles: signingMode === 'manual' && current.provisioningProfiles.length === 0
        ? [{ bundleId: '', profileName: '' }]
        : current.provisioningProfiles,
    }))
    setErrors({})
  }
  function updateProfile(index: number, field: 'bundleId' | 'profileName', value: string) {
    setValues((current) => ({
      ...current,
      provisioningProfiles: current.provisioningProfiles.map((profile, profileIndex) => profileIndex === index ? { ...profile, [field]: value } : profile),
    }))
    setErrors((current) => ({ ...current, [`provisioningProfiles.${index}.${field}`]: '', provisioningProfiles: '' }))
  }
  function addProfile() {
    setValues((current) => ({ ...current, provisioningProfiles: [...current.provisioningProfiles, { bundleId: '', profileName: '' }] }))
  }
  function removeProfile(index: number) {
    setValues((current) => ({ ...current, provisioningProfiles: current.provisioningProfiles.filter((_, profileIndex) => profileIndex !== index) }))
    setErrors({})
  }
  function submit(event: FormEvent) {
    event.preventDefault(); const parsed = projectFormSchema.safeParse(values)
    if (!parsed.success) return setErrors(firstZodError(parsed.error))
    setErrors({}); save.mutate(parsed.data)
  }

  if (editing && project.isLoading) return <LoadingState label="Loading project" />
  if (editing && project.isError) return <ErrorState error={project.error} onRetry={() => project.refetch()} />

  return <div className="page-stack page-narrow">
    <PageHeader eyebrow={editing ? 'Project settings' : 'Project setup'} title={editing ? `Edit ${project.data?.displayName ?? projectKey}` : 'Create project'} description="Configure the repository, Firebase delivery, and Match or manual ad-hoc signing." />
    <form className="form-panel" onSubmit={submit} noValidate>
      <FormSection number="01" title="Identity & repository" description="Project identity and the runner-accessible checkout.">
        <TextField label="Project key" value={values.projectKey} error={errors.projectKey} disabled={editing} mono onChange={(v) => update('projectKey', v)} placeholder="ios-customer-app" />
        <TextField label="Display name" value={values.displayName} error={errors.displayName} onChange={(v) => update('displayName', v)} placeholder="Customer iOS" />
        <TextField label="Repository path" value={values.repoPath} error={errors.repoPath} mono full onChange={(v) => update('repoPath', v)} placeholder="/Users/runner/repos/customer-ios" />
      </FormSection>
      <FormSection number="02" title="Build settings" description="Fastlane, Xcode, and Firebase inputs used for every build.">
        <TextField label="Fastlane lane" value={values.fastlaneLane} error={errors.fastlaneLane} mono onChange={(v) => update('fastlaneLane', v)} placeholder="distribute" />
        <TextField label="Scheme (optional)" value={values.scheme ?? ''} onChange={(v) => update('scheme', v || undefined)} placeholder="Customer" />
        <TextField label="Build configuration (optional)" value={values.buildConfiguration ?? ''} onChange={(v) => update('buildConfiguration', v || undefined)} placeholder="Debug" />
        <TextField label="Firebase app ID" value={values.firebaseAppId} error={errors.firebaseAppId} mono onChange={(v) => update('firebaseAppId', v)} placeholder="1:123456789:ios:abc123" />
        <TextField label="Firebase tester groups" value={values.firebaseTesterGroupsText} error={errors.firebaseTesterGroupsText} full onChange={(v) => update('firebaseTesterGroupsText', v)} placeholder="qa, internal-testers" />
      </FormSection>
      <FormSection number="03" title="Ad-hoc signing" description="Choose Match or export with identities and profiles already configured for archive in the Xcode project and installed on the runner.">
        <label className="field field-full"><span className="field-label">Signing mode</span><select className="input select" value={values.signingMode} onChange={(event) => setSigningMode(event.target.value as SigningMode)}><option value="match">Fastlane Match</option><option value="manual">Manual signing</option></select></label>
        {values.signingMode === 'match' ? <>
          <TextField label="Match password env" value={values.matchPasswordEnvVar ?? ''} error={errors.matchPasswordEnvVar} mono onChange={(v) => update('matchPasswordEnvVar', v || undefined)} />
          <TextField label="ASC key ID env" value={values.appStoreConnectKeyIdEnvVar ?? ''} error={errors.appStoreConnectKeyIdEnvVar} mono onChange={(v) => update('appStoreConnectKeyIdEnvVar', v || undefined)} />
          <TextField label="ASC issuer ID env" value={values.appStoreConnectIssuerIdEnvVar ?? ''} error={errors.appStoreConnectIssuerIdEnvVar} mono onChange={(v) => update('appStoreConnectIssuerIdEnvVar', v || undefined)} />
          <TextField label="ASC key path env" value={values.appStoreConnectKeyPathEnvVar ?? ''} error={errors.appStoreConnectKeyPathEnvVar} mono onChange={(v) => update('appStoreConnectKeyPathEnvVar', v || undefined)} />
        </> : <>
          <TextField label="Apple Team ID" value={values.appleTeamId ?? ''} error={errors.appleTeamId} mono onChange={(v) => update('appleTeamId', v.toUpperCase() || undefined)} placeholder="AB12CDEFGH" />
          <TextField label="Signing certificate" value={values.signingCertificate} error={errors.signingCertificate} onChange={(v) => update('signingCertificate', v)} placeholder="Apple Distribution" />
          <div className="profile-mappings field-full">
            <div className="profile-mappings-heading"><div><span className="field-label">Provisioning profiles</span><p>Map every archived app and extension bundle ID to an installed profile name for IPA export.</p></div><button className="button button-secondary button-small" type="button" onClick={addProfile}>Add mapping</button></div>
            <FieldError message={errors.provisioningProfiles} />
            {values.provisioningProfiles.map((profile, index) => <div className="profile-mapping-row" key={index}>
              <TextField label="Bundle ID" value={profile.bundleId} error={errors[`provisioningProfiles.${index}.bundleId`]} mono onChange={(v) => updateProfile(index, 'bundleId', v)} placeholder="com.company.app" />
              <TextField label="Profile name" value={profile.profileName} error={errors[`provisioningProfiles.${index}.profileName`]} onChange={(v) => updateProfile(index, 'profileName', v)} placeholder="MyApp AdHoc" />
              <button className="button button-ghost danger-text profile-remove" type="button" onClick={() => removeProfile(index)} aria-label={`Remove provisioning profile mapping ${index + 1}`}>Remove</button>
            </div>)}
          </div>
        </>}
      </FormSection>
      <FormSection number="04" title="Notifications & runner" description="Route build updates to this project's Lark group and keep secret values on the runner.">
        <TextField label="Lark group chat ID (optional, starts with oc_)" value={values.larkNotificationChatId ?? ''} error={errors.larkNotificationChatId} mono full onChange={(v) => update('larkNotificationChatId', v || undefined)} placeholder="oc_xxxxxxxxxxxxxxxx" />
        <TextField label="Firebase CLI token env" value={values.firebaseCliTokenEnvVar} error={errors.firebaseCliTokenEnvVar} mono full onChange={(v) => update('firebaseCliTokenEnvVar', v)} />
        <label className="toggle-field field-full"><span><strong>Project enabled</strong><small>Creation/update validates the project before enabling it.</small></span><input type="checkbox" checked={values.enabled} onChange={(e) => update('enabled', e.target.checked)} /><span className="toggle" /></label>
      </FormSection>
      {save.isError && <div className="inline-alert" role="alert"><strong>Could not save project.</strong> {save.error.message}</div>}
      <div className="form-actions"><Link className="button button-ghost" to={editing ? `/projects/${projectKey}` : '/projects'}>Cancel</Link><button className="button button-primary" disabled={save.isPending}>{save.isPending ? 'Saving…' : editing ? 'Save changes' : 'Create project'}</button></div>
    </form>
  </div>
}

function FormSection({ number, title, description, children }: { number: string; title: string; description: string; children: ReactNode }) {
  return <section className="form-section"><div className="form-section-heading"><span>{number}</span><div><h2>{title}</h2><p>{description}</p></div></div><div className="form-grid">{children}</div></section>
}
function TextField({ label, value, onChange, error, placeholder, mono, full, disabled }: { label: string; value: string; onChange: (value: string) => void; error?: string; placeholder?: string; mono?: boolean; full?: boolean; disabled?: boolean }) {
  return <label className={`field ${full ? 'field-full' : ''}`}><span className="field-label">{label}</span><input className={`input ${mono ? 'mono' : ''}`} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} disabled={disabled} /><FieldError message={error} /></label>
}
