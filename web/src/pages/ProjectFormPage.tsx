import { FormEvent, useEffect, useRef, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api } from '../api/client'
import type { ProjectInput, ProjectUpdateInput, SigningCertificateCandidate, SigningInventory, SigningInventoryProfile, SigningMode } from '../types'
import { firstZodError, parseTesterGroups, projectFormSchema, type ProjectFormValues } from '../lib/validation'
import { ErrorState, FieldError, LoadingState, PageHeader } from '../components/ui'

function envReferenceOrUndefined(value: string | undefined): string | undefined {
  return value && /^[A-Z][A-Z0-9_]*$/.test(value) ? value : undefined
}

let profileRowSequence = 0
function nextProfileRowId(): string {
  profileRowSequence += 1
  return `profile-row-${profileRowSequence}`
}

type ProfileFormRow = ProjectFormValues['provisioningProfiles'][number] & { rowId: string }
type ProjectFormState = Omit<ProjectFormValues, 'provisioningProfiles'> & { provisioningProfiles: ProfileFormRow[] }

const emptyProject: ProjectFormState = {
  projectKey: '', displayName: '', repoPath: '', fastlaneLane: 'distribute', scheme: undefined,
  buildConfiguration: 'Debug', firebaseAppId: '', firebaseTesterGroupsText: '',
  firebaseCliTokenEnvVar: 'FIREBASE_CLI_TOKEN', matchPasswordEnvVar: 'MATCH_PASSWORD',
  appStoreConnectKeyIdEnvVar: undefined, appStoreConnectIssuerIdEnvVar: undefined,
  appStoreConnectKeyPathEnvVar: undefined, signingMode: 'match', appleTeamId: undefined,
  signingCertificate: 'Apple Distribution', provisioningProfiles: [], larkNotificationChatId: undefined,
  enabled: false, version: undefined,
}

function emptyProfileRow(): ProfileFormRow {
  return { bundleId: '', profileName: '', rowId: nextProfileRowId() }
}

function distributionFingerprints(profile: SigningInventoryProfile): string[] {
  return profile.certificateCandidates.filter((certificate) => certificate.kind === 'distribution').map((certificate) => certificate.sha1Fingerprint)
}

export function ProjectFormPage() {
  const { projectKey } = useParams()
  const editing = Boolean(projectKey)
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [values, setValues] = useState<ProjectFormState>(emptyProject)
  const valuesRef = useRef(values)
  valuesRef.current = values
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [importMessage, setImportMessage] = useState<{ tone: 'error' | 'info'; text: string } | null>(null)
  const formGeneration = useRef(0)
  const formDirty = useRef(false)
  const hydratedProjectKey = useRef<string | undefined>(undefined)
  const routeProjectKey = useRef(projectKey)
  if (routeProjectKey.current !== projectKey) {
    routeProjectKey.current = projectKey
    formGeneration.current += 1
    formDirty.current = false
    hydratedProjectKey.current = undefined
  }
  const project = useQuery({ queryKey: ['projects', projectKey], queryFn: () => api.getProject(projectKey!), enabled: editing })
  const inventory = useQuery({ queryKey: ['signing', 'inventory'], queryFn: () => api.getSigningInventory(), enabled: values.signingMode === 'manual' })

  useEffect(() => {
    if (!project.data) return
    const data = project.data
    if (hydratedProjectKey.current === data.projectKey && formDirty.current) return
    hydratedProjectKey.current = data.projectKey
    formDirty.current = false
    formGeneration.current += 1
    setImportMessage(null)
    setValues({
      projectKey: data.projectKey, displayName: data.displayName, repoPath: data.repoPath,
      fastlaneLane: data.fastlaneLane, scheme: data.scheme ?? undefined,
      buildConfiguration: data.buildConfiguration ?? undefined, firebaseAppId: data.firebaseAppId,
      firebaseTesterGroupsText: data.firebaseTesterGroups.join(', '), firebaseCliTokenEnvVar: data.firebaseCliTokenEnvVar,
      matchPasswordEnvVar: data.matchPasswordEnvVar ?? undefined, appStoreConnectKeyIdEnvVar: data.appStoreConnectKeyIdEnvVar ?? undefined,
      appStoreConnectIssuerIdEnvVar: data.appStoreConnectIssuerIdEnvVar ?? undefined, appStoreConnectKeyPathEnvVar: data.appStoreConnectKeyPathEnvVar ?? undefined,
      signingMode: data.signingMode, appleTeamId: data.appleTeamId ?? undefined,
      signingCertificate: data.signingCertificate, provisioningProfiles: data.provisioningProfiles.map((profile) => ({ ...profile, rowId: nextProfileRowId() })),
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
  const repositoryChoice = useMutation({ mutationFn: api.chooseRepository })
  const signingImport = useMutation({ mutationFn: () => api.chooseSigningProfile() })

  function update<K extends keyof ProjectFormState>(key: K, value: ProjectFormState[K]) {
    formDirty.current = true
    setValues((current) => ({ ...current, [key]: value })); setErrors((current) => ({ ...current, [key]: '' }))
  }
  function setSigningMode(signingMode: SigningMode) {
    formDirty.current = true
    setValues((current) => ({
      ...current,
      signingMode,
      provisioningProfiles: signingMode === 'manual' && current.provisioningProfiles.length === 0
        ? [emptyProfileRow()]
        : current.provisioningProfiles,
    }))
    setErrors({})
  }
  function addProfile() {
    formDirty.current = true
    setValues((current) => ({ ...current, provisioningProfiles: [...current.provisioningProfiles, emptyProfileRow()] }))
  }
  function removeProfile(rowId: string) {
    formDirty.current = true
    setValues((current) => {
      const provisioningProfiles = current.provisioningProfiles.filter((profile) => profile.rowId !== rowId)
      const hasMappedProfile = provisioningProfiles.some((profile) => profile.bundleId)
      return { ...current, provisioningProfiles, appleTeamId: hasMappedProfile ? current.appleTeamId : undefined }
    })
    setErrors({})
  }
  /** Fills a mapping row from an installed profile and derives the project-wide team and certificate from it. */
  function applyProfile(rowId: string, profile: SigningInventoryProfile): boolean {
    const current = valuesRef.current
    const others = current.provisioningProfiles.filter((row) => row.rowId !== rowId && row.bundleId)
    const index = current.provisioningProfiles.findIndex((row) => row.rowId === rowId)
    if (others.some((row) => row.bundleId.toLowerCase() === profile.bundleId.toLowerCase())) {
      setErrors((existing) => ({ ...existing, [`provisioningProfiles.${index}.bundleId`]: `${profile.bundleId} is already mapped` }))
      return false
    }
    if (others.length > 0 && current.appleTeamId && current.appleTeamId !== profile.teamId) {
      setErrors((existing) => ({ ...existing, provisioningProfiles: `All provisioning profiles must use the same Apple Team ID (${current.appleTeamId})` }))
      return false
    }

    const fingerprints = distributionFingerprints(profile)
    const keepCertificate = fingerprints.includes(current.signingCertificate)
      || (others.length > 0 && /^[A-F0-9]{40}$/.test(current.signingCertificate))
    const signingCertificate = keepCertificate
      ? current.signingCertificate
      : profile.recommendedCertificate?.sha1Fingerprint ?? fingerprints[0] ?? current.signingCertificate

    formDirty.current = true
    setValues((state) => ({
      ...state,
      appleTeamId: profile.teamId,
      signingCertificate,
      provisioningProfiles: state.provisioningProfiles.map((row) => row.rowId === rowId
        ? { ...row, bundleId: profile.bundleId, profileName: profile.profileName, profileUuid: profile.uuid }
        : row),
    }))
    setErrors((existing) => ({
      ...existing,
      appleTeamId: '', signingCertificate: '', provisioningProfiles: '',
      [`provisioningProfiles.${index}.bundleId`]: '', [`provisioningProfiles.${index}.profileName`]: '',
    }))
    return true
  }
  function chooseProfile(rowId: string, uuid: string) {
    if (!uuid) {
      formDirty.current = true
      setValues((current) => ({
        ...current,
        provisioningProfiles: current.provisioningProfiles.map((row) => row.rowId === rowId ? { bundleId: '', profileName: '', rowId } : row),
      }))
      return
    }
    const profile = inventory.data?.profiles.find((candidate) => candidate.uuid === uuid)
    if (profile) applyProfile(rowId, profile)
  }
  async function chooseRepository() {
    const generation = formGeneration.current
    try {
      const repository = await repositoryChoice.mutateAsync()
      if (formGeneration.current !== generation) return
      if (repository) update('repoPath', repository.path)
    } catch {
      if (formGeneration.current !== generation) repositoryChoice.reset()
      // Current-form errors are rendered next to the selected repository.
    }
  }
  async function importProfile() {
    const generation = formGeneration.current
    setImportMessage(null)
    try {
      const result = await signingImport.mutateAsync()
      if (formGeneration.current !== generation || !result) return
      await inventory.refetch()
      const imported = result.profiles.find((candidate) => candidate.uuid === result.importedProfileUuid)
      if (!imported) throw new Error('The imported profile could not be detected after installation')

      const rows = valuesRef.current.provisioningProfiles
      const existingRow = rows.find((row) => row.bundleId.toLowerCase() === result.bundleId.toLowerCase())
      const emptyRow = rows.find((row) => !row.bundleId)
      let targetRowId = existingRow?.rowId ?? emptyRow?.rowId
      if (!targetRowId) {
        const row = emptyProfileRow()
        targetRowId = row.rowId
        valuesRef.current = { ...valuesRef.current, provisioningProfiles: [...rows, row] }
        setValues((current) => ({ ...current, provisioningProfiles: [...current.provisioningProfiles, row] }))
      }
      if (applyProfile(targetRowId, { ...imported, bundleId: result.bundleId })) {
        setImportMessage({ tone: 'info', text: `Installed ${imported.profileName} for ${result.bundleId}.` })
      }
    } catch (error) {
      if (formGeneration.current !== generation) return
      setImportMessage({ tone: 'error', text: error instanceof Error ? error.message : 'Provisioning profile import failed' })
    }
  }
  function submit(event: FormEvent) {
    event.preventDefault()
    if (repositoryChoice.isPending || signingImport.isPending) return
    const parsed = projectFormSchema.safeParse(values)
    if (!parsed.success) return setErrors(firstZodError(parsed.error))
    setErrors({}); save.mutate(parsed.data)
  }

  if (editing && project.isLoading) return <LoadingState label="Loading project" />
  if (editing && project.isError) return <ErrorState error={project.error} onRetry={() => project.refetch()} />

  const mappedProfiles = values.provisioningProfiles
    .map((row) => inventory.data?.profiles.find((candidate) => candidate.uuid === row.profileUuid))
    .filter((profile): profile is SigningInventoryProfile => Boolean(profile))
  const unsupportedCertificate = mappedProfiles.find((profile) => {
    const fingerprints = distributionFingerprints(profile)
    return fingerprints.length > 0 && !fingerprints.includes(values.signingCertificate)
  })

  return <div className="page-stack page-narrow">
    <PageHeader eyebrow={editing ? 'Project settings' : 'Project setup'} title={editing ? `Edit ${project.data?.displayName ?? projectKey}` : 'Create project'} description="Configure the repository, Firebase delivery, and Match or manual ad-hoc signing." />
    <form className="form-panel" onSubmit={submit} noValidate>
      <fieldset className="form-fieldset" disabled={save.isPending}>
      <FormSection number="01" title="Identity & repository" description="Project identity and the runner-accessible checkout.">
        <TextField label="Project key" value={values.projectKey} error={errors.projectKey} disabled={editing} mono onChange={(v) => update('projectKey', v)} placeholder="ios-customer-app" />
        <TextField label="Display name" value={values.displayName} error={errors.displayName} onChange={(v) => update('displayName', v)} placeholder="Customer iOS" />
        <RepositoryPicker
          editing={editing}
          value={values.repoPath}
          error={errors.repoPath}
          choosing={repositoryChoice.isPending}
          chooseError={repositoryChoice.isError ? repositoryChoice.error : undefined}
          onChoose={() => void chooseRepository()}
        />
      </FormSection>
      <FormSection number="02" title="Build settings" description="Fastlane, Xcode, and Firebase inputs used for every build.">
        <TextField label="Fastlane lane" value={values.fastlaneLane} error={errors.fastlaneLane} mono onChange={(v) => update('fastlaneLane', v)} placeholder="distribute" />
        <TextField label="Scheme (optional)" value={values.scheme ?? ''} onChange={(v) => update('scheme', v || undefined)} placeholder="Customer" />
        <TextField label="Build configuration (optional)" value={values.buildConfiguration ?? ''} onChange={(v) => update('buildConfiguration', v || undefined)} placeholder="Debug" />
        <TextField label="Firebase app ID" value={values.firebaseAppId} error={errors.firebaseAppId} mono onChange={(v) => update('firebaseAppId', v)} placeholder="1:123456789:ios:abc123" />
        <TextField label="Firebase tester groups" value={values.firebaseTesterGroupsText} error={errors.firebaseTesterGroupsText} full onChange={(v) => update('firebaseTesterGroupsText', v)} placeholder="qa, internal-testers" />
      </FormSection>
      <FormSection number="03" title="Ad-hoc signing" description="Choose Match, or pick provisioning profiles and a certificate already installed on the runner Mac.">
        <label className="field field-full"><span className="field-label">Signing mode</span><select className="input select" value={values.signingMode} disabled={signingImport.isPending} onChange={(event) => setSigningMode(event.target.value as SigningMode)}><option value="match">Fastlane Match</option><option value="manual">Manual signing</option></select></label>
        {values.signingMode === 'match' ? <>
          <TextField label="Match password env" value={values.matchPasswordEnvVar ?? ''} error={errors.matchPasswordEnvVar} mono onChange={(v) => update('matchPasswordEnvVar', v || undefined)} />
          <TextField label="ASC key ID env" value={values.appStoreConnectKeyIdEnvVar ?? ''} error={errors.appStoreConnectKeyIdEnvVar} mono onChange={(v) => update('appStoreConnectKeyIdEnvVar', v || undefined)} />
          <TextField label="ASC issuer ID env" value={values.appStoreConnectIssuerIdEnvVar ?? ''} error={errors.appStoreConnectIssuerIdEnvVar} mono onChange={(v) => update('appStoreConnectIssuerIdEnvVar', v || undefined)} />
          <TextField label="ASC key path env" value={values.appStoreConnectKeyPathEnvVar ?? ''} error={errors.appStoreConnectKeyPathEnvVar} mono onChange={(v) => update('appStoreConnectKeyPathEnvVar', v || undefined)} />
        </> : <>
          <div className="profile-mappings field-full">
            <div className="profile-mappings-heading">
              <div><span className="field-label">Provisioning profiles</span><p>Pick an installed Ad Hoc profile for the app and every extension. Bundle ID and Team ID are filled from the profile.</p></div>
              <div className="field-action-buttons">
                <button className="button button-secondary button-small" type="button" disabled={inventory.isFetching || signingImport.isPending} onClick={() => void inventory.refetch()}>{inventory.isFetching ? 'Refreshing…' : 'Refresh list'}</button>
                <button className="button button-secondary button-small" type="button" disabled={signingImport.isPending} onClick={() => void importProfile()}>{signingImport.isPending ? 'Importing…' : 'Import .mobileprovision…'}</button>
                <button className="button button-secondary button-small" type="button" disabled={signingImport.isPending} onClick={addProfile}>Add profile</button>
              </div>
            </div>
            <FieldError message={errors.provisioningProfiles} />
            {inventory.isLoading && <p className="repository-picker-status">Loading installed profiles and certificates…</p>}
            {inventory.isError && <p className="repository-picker-status is-error" role="alert">Could not load installed signing assets: {inventory.error.message}</p>}
            {inventory.data && inventory.data.profiles.length === 0 && <p className="repository-picker-status is-warning">No valid Ad Hoc profiles are installed on the runner. Import a .mobileprovision file to add one.</p>}
            {importMessage && <p className={`repository-picker-status ${importMessage.tone === 'error' ? 'is-error' : ''}`} role={importMessage.tone === 'error' ? 'alert' : 'status'}>{importMessage.text}</p>}
            {inventory.data && <WarningList warnings={inventory.data.warnings} />}
            {values.provisioningProfiles.map((row, index) => <div className="profile-mapping-row profile-select-row" key={row.rowId}>
              <div className="field">
                <label className="field-label" htmlFor={`${row.rowId}-profile`}>Provisioning profile {index + 1}</label>
                <select id={`${row.rowId}-profile`} className="input select" value={row.profileUuid ?? (row.bundleId ? `saved:${row.rowId}` : '')} disabled={signingImport.isPending} onChange={(event) => chooseProfile(row.rowId, event.target.value)}>
                  <option value="">Choose a profile</option>
                  <ProfileOptions row={row} inventory={inventory.data} />
                </select>
                {row.bundleId && <small className="profile-select-hint">Bundle ID <code>{row.bundleId}</code></small>}
                <FieldError message={errors[`provisioningProfiles.${index}.bundleId`] || errors[`provisioningProfiles.${index}.profileName`]} />
              </div>
              <button className="button button-ghost danger-text profile-remove" type="button" disabled={signingImport.isPending} onClick={() => removeProfile(row.rowId)} aria-label={`Remove provisioning profile ${index + 1}`}>Remove</button>
            </div>)}
          </div>
          <div className="field field-full">
            <label className="field-label" htmlFor="signing-certificate">Signing certificate</label>
            <select id="signing-certificate" className="input select mono" value={values.signingCertificate} disabled={signingImport.isPending} onChange={(event) => update('signingCertificate', event.target.value)}>
              <option value="">Choose a certificate</option>
              <CertificateOptions value={values.signingCertificate} certificates={inventory.data?.certificates ?? []} />
            </select>
            <FieldError message={errors.signingCertificate || (unsupportedCertificate ? `${unsupportedCertificate.profileName} does not include this certificate` : undefined)} />
          </div>
          <div className="field field-full">
            <label className="field-label" htmlFor="apple-team-id">Apple Team ID</label>
            <input id="apple-team-id" className="input mono" readOnly value={values.appleTeamId ?? ''} placeholder="Filled from the selected profile" />
            <FieldError message={errors.appleTeamId} />
          </div>
        </>}
      </FormSection>
      <FormSection number="04" title="Notifications & runner" description="Route build updates to this project's Lark group and keep secret values on the runner.">
        <TextField label="Lark group chat ID (optional, starts with oc_)" value={values.larkNotificationChatId ?? ''} error={errors.larkNotificationChatId} mono full onChange={(v) => update('larkNotificationChatId', v || undefined)} placeholder="oc_xxxxxxxxxxxxxxxx" />
        <TextField label="Firebase CLI token env" value={values.firebaseCliTokenEnvVar} error={errors.firebaseCliTokenEnvVar} mono full onChange={(v) => update('firebaseCliTokenEnvVar', v)} />
        <label className="toggle-field field-full"><span><strong>Project enabled</strong><small>Creation/update validates the project before enabling it.</small></span><input type="checkbox" checked={values.enabled} onChange={(e) => update('enabled', e.target.checked)} /><span className="toggle" /></label>
      </FormSection>
      {save.isError && <div className="inline-alert" role="alert"><strong>Could not save project.</strong> {save.error.message}</div>}
      <div className="form-actions"><Link className="button button-ghost" to={editing ? `/projects/${projectKey}` : '/projects'}>Cancel</Link><button className="button button-primary" disabled={save.isPending || repositoryChoice.isPending || signingImport.isPending}>{save.isPending ? 'Saving…' : repositoryChoice.isPending ? 'Choosing repository…' : signingImport.isPending ? 'Importing profile…' : editing ? 'Save changes' : 'Create project'}</button></div>
      </fieldset>
    </form>
  </div>
}

function ProfileOptions({ row, inventory }: { row: ProfileFormRow; inventory?: SigningInventory }) {
  const profiles = inventory?.profiles ?? []
  const installed = Boolean(row.profileUuid && profiles.some((profile) => profile.uuid === row.profileUuid))
  return <>
    {row.bundleId && !installed && <option value={row.profileUuid ?? `saved:${row.rowId}`}>{row.bundleId} — {row.profileName} (current, not in installed list)</option>}
    {profiles.map((profile) => <option key={profile.uuid} value={profile.uuid}>{profile.bundleId} — {profile.profileName} ({profile.teamId}, expires {formatExpiry(profile.expiresAt)})</option>)}
  </>
}

function CertificateOptions({ value, certificates }: { value: string; certificates: SigningCertificateCandidate[] }) {
  const known = certificates.some((certificate) => certificate.sha1Fingerprint === value)
  return <>
    {value && !known && <option value={value}>{value} (current)</option>}
    {certificates.map((certificate) => <option key={certificate.sha1Fingerprint} value={certificate.sha1Fingerprint}>{certificate.name} — {shortFingerprint(certificate.sha1Fingerprint)}</option>)}
  </>
}

function RepositoryPicker({ editing, value, error, choosing, chooseError, onChoose }: { editing: boolean; value: string; error?: string; choosing: boolean; chooseError?: Error; onChoose: () => void }) {
  return <div className="field field-full repository-picker">
    <span className="field-label">Repository</span>
    <div className={`repository-folder-choice ${value ? 'has-value' : ''}`}>
      <div>
        <strong>{value ? 'Selected repository' : 'No repository selected'}</strong>
        {value && <code>{value}</code>}
      </div>
      <button className="button button-secondary" type="button" disabled={choosing} onClick={onChoose}>{choosing ? 'Choosing…' : value ? 'Change folder…' : 'Choose folder…'}</button>
    </div>
    <FieldError message={error} />
    <p className="repository-picker-status">The native folder dialog opens on the Mac running the API. Choose a folder under <code>IOS_REPO_ROOTS</code>; missing Fastlane files are created automatically. Run <code>bundle install</code> separately before validation.</p>
    {editing && value && <p className="repository-picker-status is-warning">The saved path can remain unchanged while this project stays disabled. Choosing another folder or enabling the project revalidates it.</p>}
    {chooseError && <p className="repository-picker-status is-error" role="alert">{chooseError.message}</p>}
  </div>
}

function WarningList({ warnings }: { warnings: SigningInventory['warnings'] }) {
  if (warnings.length === 0) return null
  return <ul className="signing-discovery-warnings">{warnings.map((warning, index) => <li key={`${warning.code}-${index}`}>{warning.message}</li>)}</ul>
}

function formatExpiry(value: string): string {
  return new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' }).format(new Date(value))
}

function shortFingerprint(value: string): string {
  return `${value.slice(0, 8)}…${value.slice(-8)}`
}

function FormSection({ number, title, description, children }: { number: string; title: string; description: string; children: ReactNode }) {
  return <section className="form-section"><div className="form-section-heading"><span>{number}</span><div><h2>{title}</h2><p>{description}</p></div></div><div className="form-grid">{children}</div></section>
}
function TextField({ label, value, onChange, error, placeholder, mono, full, disabled }: { label: string; value: string; onChange: (value: string) => void; error?: string; placeholder?: string; mono?: boolean; full?: boolean; disabled?: boolean }) {
  return <label className={`field ${full ? 'field-full' : ''}`}><span className="field-label">{label}</span><input className={`input ${mono ? 'mono' : ''}`} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} disabled={disabled} /><FieldError message={error} /></label>
}
