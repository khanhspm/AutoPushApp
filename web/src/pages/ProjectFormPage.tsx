import { FormEvent, useEffect, useRef, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api } from '../api/client'
import type { ProjectInput, ProjectUpdateInput, SigningDiscoveryResult, SigningMode, SigningProfileCandidate } from '../types'
import { firstZodError, isConcreteBundleId, parseTesterGroups, projectFormSchema, type ProjectFormValues } from '../lib/validation'
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

type RowDiscoveryState =
  | { status: 'empty'; bundleId: string; result: SigningDiscoveryResult }
  | { status: 'result'; action: 'detect' | 'import'; bundleId: string; result: SigningDiscoveryResult; selectedProfileUuid?: string; appliedProfileUuid?: string; selectedCertificateFingerprint?: string }
  | { status: 'error'; bundleId: string; action: 'detect' | 'import'; message: string }

const emptyProject: ProjectFormState = {
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
  const [values, setValues] = useState<ProjectFormState>(emptyProject)
  const valuesRef = useRef(values)
  valuesRef.current = values
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [discoveryByRow, setDiscoveryByRow] = useState<Record<string, RowDiscoveryState>>({})
  const [detectingRowId, setDetectingRowId] = useState<string | null>(null)
  const [importingRowId, setImportingRowId] = useState<string | null>(null)
  const discoveryGeneration = useRef<Record<string, number>>({})
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

  useEffect(() => {
    if (!project.data) return
    const data = project.data
    if (hydratedProjectKey.current === data.projectKey && formDirty.current) return
    hydratedProjectKey.current = data.projectKey
    formDirty.current = false
    formGeneration.current += 1
    discoveryGeneration.current = {}
    setDiscoveryByRow({})
    setDetectingRowId(null)
    setImportingRowId(null)
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
  const signingDiscovery = useMutation({ mutationFn: (bundleId: string) => api.discoverSigning(bundleId) })
  const signingImport = useMutation({
    mutationFn: ({ expectedBundleId }: { expectedBundleId?: string }) => api.chooseSigningProfile(expectedBundleId),
  })

  function update<K extends keyof ProjectFormState>(key: K, value: ProjectFormState[K]) {
    formDirty.current = true
    setValues((current) => ({ ...current, [key]: value })); setErrors((current) => ({ ...current, [key]: '' }))
  }
  function invalidateRow(rowId: string) {
    discoveryGeneration.current[rowId] = (discoveryGeneration.current[rowId] ?? 0) + 1
    setDiscoveryByRow((current) => {
      const { [rowId]: _removed, ...rest } = current
      return rest
    })
    setDetectingRowId((current) => current === rowId ? null : current)
    setImportingRowId((current) => current === rowId ? null : current)
  }
  function invalidateAllRows() {
    for (const row of valuesRef.current.provisioningProfiles) {
      discoveryGeneration.current[row.rowId] = (discoveryGeneration.current[row.rowId] ?? 0) + 1
    }
    setDiscoveryByRow({})
    setDetectingRowId(null)
    setImportingRowId(null)
  }
  function setSigningMode(signingMode: SigningMode) {
    formDirty.current = true
    invalidateAllRows()
    setValues((current) => ({
      ...current,
      signingMode,
      provisioningProfiles: signingMode === 'manual' && current.provisioningProfiles.length === 0
        ? [{ bundleId: '', profileName: '', rowId: nextProfileRowId() }]
        : current.provisioningProfiles,
    }))
    setErrors({})
  }
  function updateProfile(rowId: string, field: 'bundleId' | 'profileName', value: string) {
    formDirty.current = true
    invalidateRow(rowId)
    setValues((current) => ({
      ...current,
      provisioningProfiles: current.provisioningProfiles.map((profile) => profile.rowId === rowId ? { ...profile, [field]: value, profileUuid: undefined } : profile),
    }))
    const index = valuesRef.current.provisioningProfiles.findIndex((profile) => profile.rowId === rowId)
    setErrors((current) => ({ ...current, [`provisioningProfiles.${index}.${field}`]: '', provisioningProfiles: '' }))
  }
  function addProfile() {
    formDirty.current = true
    setValues((current) => ({ ...current, provisioningProfiles: [...current.provisioningProfiles, { bundleId: '', profileName: '', rowId: nextProfileRowId() }] }))
  }
  function removeProfile(rowId: string) {
    formDirty.current = true
    invalidateRow(rowId)
    setValues((current) => ({ ...current, provisioningProfiles: current.provisioningProfiles.filter((profile) => profile.rowId !== rowId) }))
    setErrors({})
  }
  function applyProfile(rowId: string, profile: SigningProfileCandidate) {
    formDirty.current = true
    const otherAppliedProfiles = Object.entries(discoveryByRow).flatMap(([otherRowId, state]) => {
      if (otherRowId === rowId || state.status !== 'result' || !state.appliedProfileUuid) return []
      const applied = state.result.profiles.find((candidate) => candidate.uuid === state.appliedProfileUuid)
      return applied ? [applied] : []
    })
    const incompatibleTeam = otherAppliedProfiles.some((candidate) => candidate.teamId !== profile.teamId)
    const distributionFingerprints = (candidate: SigningProfileCandidate) => candidate.certificateCandidates
      .filter((certificate) => certificate.kind === 'distribution')
      .map((certificate) => certificate.sha1Fingerprint)
    const profileFingerprints = distributionFingerprints(profile)
    const knownOtherFingerprints = otherAppliedProfiles.map(distributionFingerprints).filter((fingerprints) => fingerprints.length > 0)
    const currentFingerprint = /^[A-F0-9]{40}$/.test(values.signingCertificate) ? values.signingCertificate : undefined
    const incompatibleCertificate = (
      Boolean(currentFingerprint && profileFingerprints.length > 0 && !profileFingerprints.includes(currentFingerprint))
      || Boolean(profileFingerprints.length > 0 && knownOtherFingerprints.length > 0
        && !profileFingerprints.some((fingerprint) => knownOtherFingerprints.every((fingerprints) => fingerprints.includes(fingerprint))))
    )
    if (incompatibleTeam || incompatibleCertificate) {
      setErrors((current) => ({
        ...current,
        provisioningProfiles: incompatibleTeam
          ? 'All provisioning profiles must use the same Apple Team ID'
          : 'All provisioning profiles must support the same distribution certificate',
      }))
      return
    }

    setValues((current) => ({
      ...current,
      appleTeamId: profile.teamId,
      signingCertificate: profile.recommendedCertificate?.sha1Fingerprint ?? current.signingCertificate,
      provisioningProfiles: current.provisioningProfiles.map((row) => row.rowId === rowId ? { ...row, profileName: profile.profileName, profileUuid: profile.uuid } : row),
    }))
    setErrors((current) => ({ ...current, appleTeamId: '', signingCertificate: '', provisioningProfiles: '' }))
    setDiscoveryByRow((current) => {
      const state = current[rowId]
      if (!state || state.status !== 'result') return current
      return { ...current, [rowId]: { ...state, selectedProfileUuid: profile.uuid, appliedProfileUuid: profile.uuid, selectedCertificateFingerprint: undefined } }
    })
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
  async function importProfile(rowId: string) {
    const rowIndex = valuesRef.current.provisioningProfiles.findIndex((profile) => profile.rowId === rowId)
    const row = valuesRef.current.provisioningProfiles[rowIndex]
    if (!row) return
    const bundleId = row.bundleId.trim()
    if (bundleId && !isConcreteBundleId(bundleId)) {
      setErrors((current) => ({ ...current, [`provisioningProfiles.${rowIndex}.bundleId`]: 'Use a concrete bundle ID without wildcards' }))
      return
    }

    const generation = (discoveryGeneration.current[rowId] ?? 0) + 1
    discoveryGeneration.current[rowId] = generation
    setImportingRowId(rowId)
    setErrors((current) => ({ ...current, [`provisioningProfiles.${rowIndex}.bundleId`]: '' }))

    try {
      const result = await signingImport.mutateAsync({ expectedBundleId: bundleId || undefined })
      const currentRow = valuesRef.current.provisioningProfiles.find((profile) => profile.rowId === rowId)
      if (discoveryGeneration.current[rowId] !== generation || currentRow?.bundleId.trim() !== bundleId || !result) return
      const importedProfile = result.profiles.find((candidate) => candidate.uuid === result.importedProfileUuid)
      if (!importedProfile) throw new Error('The imported profile could not be detected after installation')

      setValues((current) => ({
        ...current,
        provisioningProfiles: current.provisioningProfiles.map((profile) => profile.rowId === rowId
          ? { ...profile, bundleId: bundleId || result.bundleId }
          : profile),
      }))
      setDiscoveryByRow((current) => ({
        ...current,
        [rowId]: {
          status: 'result',
          action: 'import',
          bundleId: result.bundleId,
          result,
          selectedProfileUuid: importedProfile.uuid,
        },
      }))
      applyProfile(rowId, importedProfile)
    } catch (error) {
      const currentRow = valuesRef.current.provisioningProfiles.find((profile) => profile.rowId === rowId)
      if (discoveryGeneration.current[rowId] !== generation || currentRow?.bundleId.trim() !== bundleId) return
      setDiscoveryByRow((current) => ({
        ...current,
        [rowId]: {
          status: 'error',
          action: 'import',
          bundleId,
          message: error instanceof Error ? error.message : 'Provisioning profile import failed',
        },
      }))
    } finally {
      if (discoveryGeneration.current[rowId] === generation) setImportingRowId(null)
    }
  }
  async function detectProfile(rowId: string) {
    const rowIndex = valuesRef.current.provisioningProfiles.findIndex((profile) => profile.rowId === rowId)
    const row = valuesRef.current.provisioningProfiles[rowIndex]
    if (!row) return
    const bundleId = row.bundleId.trim()
    if (!bundleId || !isConcreteBundleId(bundleId)) {
      setErrors((current) => ({
        ...current,
        [`provisioningProfiles.${rowIndex}.bundleId`]: bundleId ? 'Use a concrete bundle ID without wildcards' : 'Enter a Bundle ID before auto-detecting',
      }))
      return
    }

    const generation = (discoveryGeneration.current[rowId] ?? 0) + 1
    discoveryGeneration.current[rowId] = generation
    setDetectingRowId(rowId)
    setDiscoveryByRow((current) => {
      const { [rowId]: _removed, ...rest } = current
      return rest
    })
    setErrors((current) => ({ ...current, [`provisioningProfiles.${rowIndex}.bundleId`]: '' }))

    try {
      const result = await signingDiscovery.mutateAsync(bundleId)
      const currentRow = valuesRef.current.provisioningProfiles.find((profile) => profile.rowId === rowId)
      if (discoveryGeneration.current[rowId] !== generation || currentRow?.bundleId.trim() !== bundleId) return
      if (result.profiles.length === 0) {
        setDiscoveryByRow((current) => ({ ...current, [rowId]: { status: 'empty', bundleId, result } }))
        return
      }
      const onlyProfile = result.profiles.length === 1 ? result.profiles[0] : undefined
      setDiscoveryByRow((current) => ({
        ...current,
        [rowId]: {
          status: 'result', action: 'detect', bundleId, result,
          selectedProfileUuid: onlyProfile?.uuid,
        },
      }))
      if (onlyProfile) applyProfile(rowId, onlyProfile)
    } catch (error) {
      const currentRow = valuesRef.current.provisioningProfiles.find((profile) => profile.rowId === rowId)
      if (discoveryGeneration.current[rowId] !== generation || currentRow?.bundleId.trim() !== bundleId) return
      setDiscoveryByRow((current) => ({ ...current, [rowId]: { status: 'error', action: 'detect', bundleId, message: error instanceof Error ? error.message : 'Signing discovery failed' } }))
    } finally {
      if (discoveryGeneration.current[rowId] === generation) setDetectingRowId(null)
    }
  }
  function selectProfileCandidate(rowId: string, uuid: string) {
    setDiscoveryByRow((current) => {
      const state = current[rowId]
      if (!state || state.status !== 'result') return current
      return { ...current, [rowId]: { ...state, selectedProfileUuid: uuid, selectedCertificateFingerprint: undefined } }
    })
  }
  function useSelectedProfile(rowId: string) {
    const state = discoveryByRow[rowId]
    if (!state || state.status !== 'result' || !state.selectedProfileUuid) return
    const profile = state.result.profiles.find((candidate) => candidate.uuid === state.selectedProfileUuid)
    if (profile) applyProfile(rowId, profile)
  }
  function selectCertificate(rowId: string, fingerprint: string) {
    setDiscoveryByRow((current) => {
      const state = current[rowId]
      if (!state || state.status !== 'result') return current
      return { ...current, [rowId]: { ...state, selectedCertificateFingerprint: fingerprint } }
    })
  }
  function useSelectedCertificate(rowId: string) {
    const state = discoveryByRow[rowId]
    if (!state || state.status !== 'result' || !state.appliedProfileUuid || !state.selectedCertificateFingerprint) return
    const profile = state.result.profiles.find((candidate) => candidate.uuid === state.appliedProfileUuid)
    const certificate = profile?.certificateCandidates.find((candidate) => candidate.sha1Fingerprint === state.selectedCertificateFingerprint && candidate.kind === 'distribution')
    if (!certificate) return
    const incompatible = Object.entries(discoveryByRow).some(([otherRowId, otherState]) => {
      if (otherRowId === rowId || otherState.status !== 'result' || !otherState.appliedProfileUuid) return false
      const otherProfile = otherState.result.profiles.find((candidate) => candidate.uuid === otherState.appliedProfileUuid)
      const fingerprints = otherProfile?.certificateCandidates
        .filter((candidate) => candidate.kind === 'distribution')
        .map((candidate) => candidate.sha1Fingerprint) ?? []
      return fingerprints.length > 0 && !fingerprints.includes(certificate.sha1Fingerprint)
    })
    if (incompatible) {
      setErrors((current) => ({ ...current, provisioningProfiles: 'All provisioning profiles must support the same distribution certificate' }))
      return
    }
    update('signingCertificate', certificate.sha1Fingerprint)
    setErrors((current) => ({ ...current, provisioningProfiles: '' }))
  }
  function submit(event: FormEvent) {
    event.preventDefault()
    if (repositoryChoice.isPending || signingDiscovery.isPending || signingImport.isPending) return
    const parsed = projectFormSchema.safeParse(values)
    if (!parsed.success) return setErrors(firstZodError(parsed.error))
    setErrors({}); save.mutate(parsed.data)
  }

  if (editing && project.isLoading) return <LoadingState label="Loading project" />
  if (editing && project.isError) return <ErrorState error={project.error} onRetry={() => project.refetch()} />

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
      <FormSection number="03" title="Ad-hoc signing" description="Choose Match or export with identities and profiles already configured for archive in the Xcode project and installed on the runner.">
        <label className="field field-full"><span className="field-label">Signing mode</span><select className="input select" value={values.signingMode} disabled={signingImport.isPending} onChange={(event) => setSigningMode(event.target.value as SigningMode)}><option value="match">Fastlane Match</option><option value="manual">Manual signing</option></select></label>
        {values.signingMode === 'match' ? <>
          <TextField label="Match password env" value={values.matchPasswordEnvVar ?? ''} error={errors.matchPasswordEnvVar} mono onChange={(v) => update('matchPasswordEnvVar', v || undefined)} />
          <TextField label="ASC key ID env" value={values.appStoreConnectKeyIdEnvVar ?? ''} error={errors.appStoreConnectKeyIdEnvVar} mono onChange={(v) => update('appStoreConnectKeyIdEnvVar', v || undefined)} />
          <TextField label="ASC issuer ID env" value={values.appStoreConnectIssuerIdEnvVar ?? ''} error={errors.appStoreConnectIssuerIdEnvVar} mono onChange={(v) => update('appStoreConnectIssuerIdEnvVar', v || undefined)} />
          <TextField label="ASC key path env" value={values.appStoreConnectKeyPathEnvVar ?? ''} error={errors.appStoreConnectKeyPathEnvVar} mono onChange={(v) => update('appStoreConnectKeyPathEnvVar', v || undefined)} />
        </> : <>
          <TextField label="Apple Team ID" value={values.appleTeamId ?? ''} error={errors.appleTeamId} mono disabled={signingImport.isPending} onChange={(v) => { invalidateAllRows(); update('appleTeamId', v.toUpperCase() || undefined) }} placeholder="AB12CDEFGH" />
          <TextField label="Signing certificate" value={values.signingCertificate} error={errors.signingCertificate} mono disabled={signingImport.isPending} onChange={(v) => { invalidateAllRows(); update('signingCertificate', v) }} placeholder="Apple Distribution or SHA-1 fingerprint" />
          <div className="profile-mappings field-full">
            <div className="profile-mappings-heading"><div><span className="field-label">Provisioning profiles</span><p>Map every archived app and extension bundle ID to an installed profile name for IPA export. The native file dialog opens on the Mac running the API.</p></div><button className="button button-secondary button-small" type="button" disabled={signingImport.isPending} onClick={addProfile}>Add mapping</button></div>
            <FieldError message={errors.provisioningProfiles} />
            {values.provisioningProfiles.map((profile, index) => {
              const detection = discoveryByRow[profile.rowId]
              return <div className="profile-mapping-row" key={profile.rowId}>
                <div className="field">
                  <div className="field-action-heading">
                    <label className="field-label" htmlFor={`${profile.rowId}-bundle-id`}>Bundle ID</label>
                    <div className="field-action-buttons">
                      <button className="button button-secondary button-small" type="button" disabled={signingDiscovery.isPending || signingImport.isPending} onClick={() => void detectProfile(profile.rowId)}>{detectingRowId === profile.rowId ? 'Detecting…' : 'Auto detect'}</button>
                      <button className="button button-secondary button-small" type="button" disabled={signingDiscovery.isPending || signingImport.isPending} onClick={() => void importProfile(profile.rowId)}>{importingRowId === profile.rowId ? 'Importing…' : 'Choose .mobileprovision…'}</button>
                    </div>
                  </div>
                  <input id={`${profile.rowId}-bundle-id`} className="input mono" value={profile.bundleId} disabled={signingImport.isPending} onChange={(event) => updateProfile(profile.rowId, 'bundleId', event.target.value)} placeholder="com.company.app" />
                  <FieldError message={errors[`provisioningProfiles.${index}.bundleId`]} />
                </div>
                <TextField label="Profile name" value={profile.profileName} error={errors[`provisioningProfiles.${index}.profileName`]} disabled={signingImport.isPending} onChange={(v) => updateProfile(profile.rowId, 'profileName', v)} placeholder="MyApp AdHoc" />
                <button className="button button-ghost danger-text profile-remove" type="button" disabled={signingImport.isPending} onClick={() => removeProfile(profile.rowId)} aria-label={`Remove provisioning profile mapping ${index + 1}`}>Remove</button>
                {detection && <SigningDiscoveryPanel rowId={profile.rowId} state={detection} onSelectProfile={(uuid) => selectProfileCandidate(profile.rowId, uuid)} onUseProfile={() => useSelectedProfile(profile.rowId)} onSelectCertificate={(fingerprint) => selectCertificate(profile.rowId, fingerprint)} onUseCertificate={() => useSelectedCertificate(profile.rowId)} />}
              </div>
            })}
          </div>
        </>}
      </FormSection>
      <FormSection number="04" title="Notifications & runner" description="Route build updates to this project's Lark group and keep secret values on the runner.">
        <TextField label="Lark group chat ID (optional, starts with oc_)" value={values.larkNotificationChatId ?? ''} error={errors.larkNotificationChatId} mono full onChange={(v) => update('larkNotificationChatId', v || undefined)} placeholder="oc_xxxxxxxxxxxxxxxx" />
        <TextField label="Firebase CLI token env" value={values.firebaseCliTokenEnvVar} error={errors.firebaseCliTokenEnvVar} mono full onChange={(v) => update('firebaseCliTokenEnvVar', v)} />
        <label className="toggle-field field-full"><span><strong>Project enabled</strong><small>Creation/update validates the project before enabling it.</small></span><input type="checkbox" checked={values.enabled} onChange={(e) => update('enabled', e.target.checked)} /><span className="toggle" /></label>
      </FormSection>
      {save.isError && <div className="inline-alert" role="alert"><strong>Could not save project.</strong> {save.error.message}</div>}
      <div className="form-actions"><Link className="button button-ghost" to={editing ? `/projects/${projectKey}` : '/projects'}>Cancel</Link><button className="button button-primary" disabled={save.isPending || repositoryChoice.isPending || signingDiscovery.isPending || signingImport.isPending}>{save.isPending ? 'Saving…' : repositoryChoice.isPending ? 'Choosing repository…' : signingImport.isPending ? 'Importing profile…' : signingDiscovery.isPending ? 'Detecting signing…' : editing ? 'Save changes' : 'Create project'}</button></div>
      </fieldset>
    </form>
  </div>
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

function SigningDiscoveryPanel({ rowId, state, onSelectProfile, onUseProfile, onSelectCertificate, onUseCertificate }: { rowId: string; state: RowDiscoveryState; onSelectProfile: (uuid: string) => void; onUseProfile: () => void; onSelectCertificate: (fingerprint: string) => void; onUseCertificate: () => void }) {
  if (state.status === 'error') return <div className="signing-discovery-panel is-error" role="alert"><strong>{state.action === 'import' ? 'Could not import provisioning profile.' : 'Could not auto-detect signing.'}</strong><p>{state.message}</p></div>
  if (state.status === 'empty') return <div className="signing-discovery-panel is-empty" aria-live="polite"><strong>No valid installed Ad Hoc profile found.</strong><p>No profile exactly matches <code>{state.bundleId}</code>. You can keep entering the values manually.</p><WarningList warnings={state.result.warnings} /></div>

  const selectedProfile = state.result.profiles.find((profile) => profile.uuid === state.selectedProfileUuid)
  const appliedProfile = state.result.profiles.find((profile) => profile.uuid === state.appliedProfileUuid)
  const distributionCertificates = appliedProfile?.certificateCandidates.filter((certificate) => certificate.kind === 'distribution') ?? []
  const exactAutoFill = state.action === 'import' || Boolean(state.result.profiles.length === 1 && state.appliedProfileUuid)
  return <div className="signing-discovery-panel" aria-live="polite">
    <div className="signing-discovery-title"><strong>{exactAutoFill ? `${state.action === 'import' ? 'Imported' : 'Detected'} ${appliedProfile?.profileName}` : `Found ${state.result.profiles.length} matching profiles`}</strong><span>{exactAutoFill ? 'Fields remain editable' : 'Choose a profile before applying it'}</span></div>
    {state.action === 'detect' && state.result.profiles.length > 1 && <div className="signing-candidate-action">
      <label className="field"><span className="field-label">Matching profile</span><select className="input select" aria-label={`Matching profile for ${state.bundleId}`} value={state.selectedProfileUuid ?? ''} onChange={(event) => onSelectProfile(event.target.value)}><option value="">Choose a profile</option>{state.result.profiles.map((profile) => <option key={profile.uuid} value={profile.uuid}>{profile.profileName} — {profile.teamId} — expires {formatExpiry(profile.expiresAt)}</option>)}</select></label>
      <button className="button button-secondary" type="button" disabled={!selectedProfile} onClick={onUseProfile}>Use selected profile</button>
    </div>}
    {(selectedProfile ?? appliedProfile) && <ProfileDetails profile={(selectedProfile ?? appliedProfile)!} />}
    {appliedProfile && (!selectedProfile || selectedProfile.uuid === appliedProfile.uuid) && !appliedProfile.recommendedCertificate && distributionCertificates.length > 1 && <div className="signing-candidate-action signing-certificate-action">
      <label className="field"><span className="field-label">Distribution certificate</span><select className="input select mono" aria-label={`Distribution certificate for ${state.bundleId}`} value={state.selectedCertificateFingerprint ?? ''} onChange={(event) => onSelectCertificate(event.target.value)}><option value="">Choose a certificate</option>{distributionCertificates.map((certificate) => <option key={certificate.sha1Fingerprint} value={certificate.sha1Fingerprint}>{certificate.name} — {shortFingerprint(certificate.sha1Fingerprint)}</option>)}</select></label>
      <button className="button button-secondary" type="button" disabled={!state.selectedCertificateFingerprint} onClick={onUseCertificate}>Use certificate</button>
    </div>}
    <WarningList warnings={[...state.result.warnings, ...(appliedProfile?.warnings ?? [])]} />
  </div>
}

function ProfileDetails({ profile }: { profile: SigningProfileCandidate }) {
  return <dl className="signing-candidate-details">
    <div><dt>Profile</dt><dd>{profile.profileName}</dd></div>
    <div><dt>Team</dt><dd>{profile.teamName ? `${profile.teamName} · ` : ''}<code>{profile.teamId}</code></dd></div>
    <div><dt>Expires</dt><dd>{formatExpiry(profile.expiresAt)}</dd></div>
    <div><dt>Certificate</dt><dd>{profile.recommendedCertificate ? <>{profile.recommendedCertificate.name} · <code>{shortFingerprint(profile.recommendedCertificate.sha1Fingerprint)}</code></> : 'Needs manual selection or entry'}</dd></div>
  </dl>
}

function WarningList({ warnings }: { warnings: SigningDiscoveryResult['warnings'] }) {
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
