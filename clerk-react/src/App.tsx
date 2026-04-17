import { useEffect, useState } from 'react'
import type { ChangeEvent, FormEvent } from 'react'
import './App.css'
import { Show, SignIn, UserButton, useUser } from '@clerk/react'
import { AnimatePresence, motion } from 'motion/react'
import DotGrid from './components/DotGrid'
import TiltedCard from './components/TiltedCard'
import Particles from './components/Particles'

type ProjectDetails = {
  id: number
  name: string
  createdBy: string
  createdOn: string
  description: string
  field: 'IT' | 'Finance'
  pdfName: string
}

type VersionSource = 'workspace' | 'toc'

type ProjectVersion = {
  id: number
  projectId: number
  source: VersionSource
  createdBy: string
  createdOn: string
  snapshot: {
    project: ProjectDetails
    tocDraft: string
    structureItems: StructureItem[]
    structureDescriptions: StructureMaps
    structureInstructions: StructureMaps
    promptFiles: Record<PromptType, string[]>
  }
}

type PromptType = 'mom' | 'drafts' | 'transcripts' | 'chats'

type PromptFileMap = Record<PromptType, File[]>

type StructureItem = {
  id: string
  number: string
  title: string
}

type StructureMaps = Record<string, string>

type TreeNode = {
  name: string
  type: 'folder' | 'file'
  children?: TreeNode[]
}

type ProjectDocumentsResponse = {
  projectId: number
  momFile: string | null
  preDocumentsFile: string | null
  transcriptsFile: string | null
  finalBrdFile?: string | null
}

type BrdGenerateResponse = {
  generated: boolean
  projectId: number
  chunksStored: number
  finalBrdFile: string
  brd: string
}

type TocSuggestedSection = {
  number: string
  title: string
  description: string
}

type TocSuggestResponse = {
  projectId: number
  sections: TocSuggestedSection[]
}

type TocRefineResponse = {
  sectionTitle: string
  description: string
}

type SectionReviewState = 'edited' | 'approved'

const EMPTY_PROMPT_FILES: PromptFileMap = {
  mom: [],
  drafts: [],
  transcripts: [],
  chats: [],
}

const DEFAULT_API_BASE_URLS = [
  'http://127.0.0.1:8000',
  'http://localhost:8000',
  'http://127.0.0.1:8080',
  'http://localhost:8080',
] as const

const ENV_API_BASE_URLS = (import.meta.env.VITE_API_BASE_URLS as string | undefined)
  ?.split(',')
  .map((url) => url.trim())
  .filter(Boolean)

const API_BASE_URLS = (ENV_API_BASE_URLS?.length ? ENV_API_BASE_URLS : DEFAULT_API_BASE_URLS) as readonly string[]
const PROJECT_CARD_IMAGE = `data:image/svg+xml;utf8,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="#0b111d"/></svg>',
)}`

const FileTreeItem = ({
  item,
  level = 0,
  autoOpen = false,
  prefix = '',
  showBranch = false,
  isLast = false,
}: {
  item: TreeNode
  level?: number
  autoOpen?: boolean
  prefix?: string
  showBranch?: boolean
  isLast?: boolean
}) => {
  const isFolder = item.type === 'folder'
  const [open, setOpen] = useState(autoOpen)
  const branchPrefix = showBranch ? `${prefix}|---` : ''
  const childPrefix = showBranch ? `${prefix}${isLast ? '    ' : '|   '}` : prefix

  useEffect(() => {
    if (autoOpen && isFolder) {
      const timer = setTimeout(() => setOpen(true), level * 120)
      return () => clearTimeout(timer)
    }
    return
  }, [autoOpen, isFolder, level])

  return (
    <div>
      <div
        className={`file-tree-item ${isFolder ? 'folder' : 'file'} ${level === 0 ? 'root' : ''}`}
        onClick={() => {
          if (isFolder) setOpen((current) => !current)
        }}
        role={isFolder ? 'button' : undefined}
        tabIndex={isFolder ? 0 : -1}
        onKeyDown={(event) => {
          if (!isFolder) return
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            setOpen((current) => !current)
          }
        }}
      >
        {level > 0 && <span className="file-tree-prefix">{branchPrefix}</span>}
        <span className="file-tree-name">{item.name}</span>
      </div>

      <AnimatePresence>
        {isFolder && open && (item.children?.length ?? 0) > 0 && (
          <motion.div
            className="file-tree-children"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.24 }}
          >
            {item.children?.map((child, index, arr) => (
              <FileTreeItem
                key={`${item.name}-${child.name}`}
                item={child}
                level={level + 1}
                autoOpen={autoOpen}
                prefix={childPrefix}
                showBranch
                isLast={index === arr.length - 1}
              />
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

function App() {
  const { user } = useUser()
  const [projects, setProjects] = useState<ProjectDetails[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [showProjectForm, setShowProjectForm] = useState(false)
  const [projectName, setProjectName] = useState('')
  const [projectField, setProjectField] = useState<'IT' | 'Finance'>('IT')
  const [projectFile, setProjectFile] = useState<File | null>(null)
  const [description, setDescription] = useState('')
  const [isCreating, setIsCreating] = useState(false)
  const [deletingId, setDeletingId] = useState<number | null>(null)
  const [activeProject, setActiveProject] = useState<ProjectDetails | null>(null)
  const [showPromptUploadFor, setShowPromptUploadFor] = useState<PromptType | null>(null)
  const [promptFiles, setPromptFiles] = useState<PromptFileMap>(EMPTY_PROMPT_FILES)
  const [showTocModal, setShowTocModal] = useState(false)
  const [isGeneratingToc, setIsGeneratingToc] = useState(false)
  const [tocDraft, setTocDraft] = useState('')
  const [structureItems, setStructureItems] = useState<StructureItem[]>([])
  const [selectedStructureId, setSelectedStructureId] = useState<string | null>(null)
  const [structureDescriptions, setStructureDescriptions] = useState<StructureMaps>({})
  const [structureInstructions, setStructureInstructions] = useState<StructureMaps>({})
  const [sectionReviewState, setSectionReviewState] = useState<Record<string, SectionReviewState>>({})
  const [showAddStructure, setShowAddStructure] = useState(false)
  const [newStructureTitle, setNewStructureTitle] = useState('')
  const [newStructureDescription, setNewStructureDescription] = useState('')
  const [isSavingVersion, setIsSavingVersion] = useState(false)
  const [showHistoryModal, setShowHistoryModal] = useState(false)
  const [isLoadingHistory, setIsLoadingHistory] = useState(false)
  const [projectVersions, setProjectVersions] = useState<ProjectVersion[]>([])
  const [workspaceDraft, setWorkspaceDraft] = useState('')
  const [isLeftSidebarCollapsed, setIsLeftSidebarCollapsed] = useState(false)
  const [isRightSidebarCollapsed] = useState(false)
  const [isChatPanelOpen, setIsChatPanelOpen] = useState(false)
  const [chatDraft, setChatDraft] = useState('')
  const [isGeneratingBrd, setIsGeneratingBrd] = useState(false)
  const [isRefiningSection, setIsRefiningSection] = useState(false)

  const createdByValue =
    user?.fullName || user?.username || user?.primaryEmailAddress?.emailAddress || 'Signed-in user'

  const requestWithFallback = async (
    endpoint: string,
    options?: RequestInit,
  ): Promise<Response> => {
    let lastError: unknown

    for (const baseUrl of API_BASE_URLS) {
      try {
        const response = await fetch(`${baseUrl}${endpoint}`, options)
        return response
      } catch (error) {
        lastError = error
      }
    }

    throw lastError ?? new Error('Unable to reach backend API')
  }

  const backendErrorMessage = `Cannot reach backend API. Tried: ${API_BASE_URLS.join(', ')}`

  const loadProjects = async () => {
    if (!user) return

    setIsLoading(true)
    try {
      const response = await requestWithFallback('/projects')
      if (!response.ok) {
        alert('Failed to load projects from backend.')
        return
      }

      const data = (await response.json()) as ProjectDetails[]
      setProjects(data)
    } catch {
      alert(backendErrorMessage)
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    void loadProjects()
  }, [user])

  const handleCreateProject = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    if (!projectFile) {
      alert('Please upload a PDF file before creating the project.')
      return
    }

    const formData = new FormData()
    formData.append('name', projectName.trim())
    formData.append('createdBy', createdByValue)
    formData.append('description', description.trim())
    formData.append('field', projectField)
    formData.append('pdfFile', projectFile)

    setIsCreating(true)
    try {
      const response = await requestWithFallback('/projects/upload', {
        method: 'POST',
        body: formData,
      })

      if (!response.ok) {
        alert('Failed to save project to database. Check backend logs.')
        return
      }

      const createdProject = (await response.json()) as ProjectDetails
      setProjects((current) => [createdProject, ...current])
    } catch {
      alert(backendErrorMessage)
      return
    } finally {
      setIsCreating(false)
    }

    setProjectName('')
    setProjectField('IT')
    setProjectFile(null)
    setDescription('')
    setShowProjectForm(false)
  }

  const handleDeleteProject = async (projectId: number) => {
    setDeletingId(projectId)

    try {
      const response = await requestWithFallback(`/projects/${projectId}`, {
        method: 'DELETE',
      })

      if (!response.ok) {
        alert('Failed to delete project from database.')
        return
      }

      setProjects((current) => current.filter((item) => item.id !== projectId))
      if (activeProject?.id === projectId) {
        setActiveProject(null)
      }
    } catch {
      alert(backendErrorMessage)
    } finally {
      setDeletingId(null)
    }
  }

  const toMockFile = (name: string): File => new File([], name)

  const hydratePromptFilesFromDocuments = (documents: ProjectDocumentsResponse) => {
    setPromptFiles({
      mom: documents.momFile ? [toMockFile(documents.momFile)] : [],
      drafts: documents.preDocumentsFile ? [toMockFile(documents.preDocumentsFile)] : [],
      transcripts: documents.transcriptsFile ? [toMockFile(documents.transcriptsFile)] : [],
      chats: [],
    })
  }

  const fetchProjectDocuments = async (projectId: number) => {
    const response = await requestWithFallback(`/projects/${projectId}/documents`)
    if (!response.ok) {
      throw new Error('Failed to fetch project documents')
    }

    const documents = (await response.json()) as ProjectDocumentsResponse
    hydratePromptFilesFromDocuments(documents)
  }

  const handleOpenProject = async (project: ProjectDetails) => {
    setActiveProject(project)
    setPromptFiles(EMPTY_PROMPT_FILES)
    setShowTocModal(false)
    setStructureItems([])
    setSelectedStructureId(null)
    setStructureDescriptions({})
    setStructureInstructions({})
    setSectionReviewState({})
    setTocDraft('')
    setIsChatPanelOpen(false)
    setChatDraft('')

    try {
      await fetchProjectDocuments(project.id)
    } catch {
      // If documents were never uploaded yet, keep empty local state.
    }
  }

  const handleBackToDashboard = () => {
    setActiveProject(null)
    setShowPromptUploadFor(null)
    setShowTocModal(false)
    setIsChatPanelOpen(false)
    setSectionReviewState({})
  }

  const handleSendChatMessage = () => {
    if (!chatDraft.trim()) return
    setChatDraft('')
  }

  const handleGenerateBrd = async () => {
    if (!activeProject) return

    setIsGeneratingBrd(true)
    try {
      const response = await requestWithFallback(`/projects/${activeProject.id}/brd/generate`, {
        method: 'POST',
      })

      if (!response.ok) {
        const message = await response.text()
        alert(`Failed to generate BRD: ${message || 'Unknown error'}`)
        return
      }

      const data = (await response.json()) as BrdGenerateResponse
      if (!data.brd?.trim()) {
        alert('BRD generation returned empty content.')
        return
      }

      setSelectedStructureId(null)
      setWorkspaceDraft(data.brd)
    } catch {
      alert(backendErrorMessage)
    } finally {
      setIsGeneratingBrd(false)
    }
  }

  const documentTypeMap: Record<Exclude<PromptType, 'chats'>, 'mom' | 'pre_documents' | 'transcripts'> = {
    mom: 'mom',
    drafts: 'pre_documents',
    transcripts: 'transcripts',
  }

  const saveProjectDocumentUpload = async (projectId: number, type: PromptType, uploadedFile: File) => {
    if (type === 'chats') return

    const formData = new FormData()
    formData.append('documentType', documentTypeMap[type])
    formData.append('file', uploadedFile)

    const response = await requestWithFallback(`/projects/${projectId}/documents/upload`, {
      method: 'POST',
      body: formData,
    })

    if (!response.ok) {
      throw new Error('Failed to save uploaded file')
    }
  }

  const handlePromptFileSelected = async (event: ChangeEvent<HTMLInputElement>) => {
    const uploadedFile = event.target.files?.[0]
    if (!uploadedFile || !showPromptUploadFor) return

    setPromptFiles((current) => {
      const existing = current[showPromptUploadFor]
      return {
        ...current,
        [showPromptUploadFor]: [...existing, uploadedFile],
      }
    })

    if (activeProject) {
      try {
        await saveProjectDocumentUpload(activeProject.id, showPromptUploadFor, uploadedFile)
      } catch {
        alert('File upload saved locally, but failed to persist to database.')
      }
    }

    event.target.value = ''
    setShowPromptUploadFor(null)
  }

  const removePromptFile = (type: PromptType, fileName: string) => {
    setPromptFiles((current) => ({
      ...current,
      [type]: current[type].filter((item) => item.name !== fileName),
    }))
  }

  const parseTocLines = (text: string): StructureItem[] => {
    const lines = text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && /^\d+\./.test(line))

    return lines.map((line, idx) => {
      const match = line.match(/^(\d+)\.\s*(.*)$/)
      const lineNumber = Number(match?.[1] || idx + 1)
      const title = (match?.[2] || line).trim()
      return {
        id: `toc-${lineNumber}-${idx + 1}`,
        number: `${lineNumber}.`,
        title,
      }
    })
  }

  const buildTocPage = (items: StructureItem[]) => {
    const title = 'TABLE OF CONTENTS'
    const maxLineLength = 44

    const lines = items.map((item, index) => {
      const pageNumber = index + 2
      const heading = `${item.number} ${item.title}`
      const dots = '.'.repeat(Math.max(4, maxLineLength - heading.length))
      return `${heading} ${dots} ${pageNumber}`
    })

    return [title, '', ...lines].join('\n')
  }

  const compileTocIntoWorkspaceDocument = (items: StructureItem[], descriptions: StructureMaps) => {
    const pageBreak = '\n\n\f\n\n'
    const tocPage = buildTocPage(items)
    const sectionPages = items.map((item) => {
      const sectionBody = (descriptions[item.id] || '').trim() || '_No content available for this section yet._'
      return `${item.number} ${item.title}\n\n${sectionBody}`
    })

    return [tocPage, ...sectionPages].join(pageBreak)
  }

  const syncTocMaps = (items: StructureItem[]) => {
    setStructureDescriptions((prev) => {
      const next: StructureMaps = {}
      for (const item of items) {
        next[item.id] = prev[item.id] ?? ''
      }
      return next
    })

    setStructureInstructions((prev) => {
      const next: StructureMaps = {}
      for (const item of items) {
        next[item.id] = prev[item.id] ?? ''
      }
      return next
    })

    setSectionReviewState((prev) => {
      const next: Record<string, SectionReviewState> = {}
      for (const item of items) {
        if (prev[item.id]) {
          next[item.id] = prev[item.id]
        }
      }
      return next
    })

    if (items.length > 0) {
      setSelectedStructureId((current) => {
        if (current && items.some((item) => item.id === current)) {
          return current
        }
        return items[0].id
      })
    } else {
      setSelectedStructureId(null)
    }
  }

  const handleSuggestToc = async () => {
    if (!activeProject) return

    setIsGeneratingToc(true)
    try {
      const response = await requestWithFallback(`/projects/${activeProject.id}/toc/suggest`, {
        method: 'POST',
      })

      if (!response.ok) {
        const message = await response.text()
        alert(`Failed to suggest structure: ${message || 'Unknown error'}`)
        return
      }

      const data = (await response.json()) as TocSuggestResponse
      if (!data.sections?.length) {
        alert('No TOC sections were generated.')
        return
      }

      const items = data.sections.map((section, index) => ({
        id: `toc-ai-${index + 1}`,
        number: section.number || `${index + 1}.`,
        title: section.title,
      }))

      const descriptions = items.reduce((acc, item, index) => {
        acc[item.id] = data.sections[index].description || ''
        return acc
      }, {} as StructureMaps)

      const instructionMap = items.reduce((acc, item) => {
        acc[item.id] = ''
        return acc
      }, {} as StructureMaps)

      setStructureItems(items)
      setStructureDescriptions(descriptions)
      setStructureInstructions(instructionMap)
      setSectionReviewState({})
      setSelectedStructureId(items[0]?.id || null)
      setTocDraft(items.map((item) => `${item.number} ${item.title}`).join('\n'))
    } catch {
      alert(backendErrorMessage)
    } finally {
      setIsGeneratingToc(false)
    }
  }

  const applyTocStructure = () => {
    const parsedItems = structureItems.length > 0 ? structureItems : parseTocLines(tocDraft)

    if (parsedItems.length === 0) {
      alert('Please generate or add TOC lines first (for example: 1. Executive Summary).')
      return
    }

    const compiledDocument = compileTocIntoWorkspaceDocument(parsedItems, structureDescriptions)
    setWorkspaceDraft(compiledDocument)
    setSelectedStructureId(null)
    setShowTocModal(false)
  }

  const selectedStructure = structureItems.find((item) => item.id === selectedStructureId) || null

  const rightPanelTreeData: TreeNode[] = [
    {
      name: activeProject?.name || 'Project',
      type: 'folder',
      children: [
        {
          name: 'MOM',
          type: 'folder',
          children: promptFiles.mom.map((file) => ({ name: file.name, type: 'file' as const })),
        },
        {
          name: 'PRE DOCUMENTS',
          type: 'folder',
          children: promptFiles.drafts.map((file) => ({ name: file.name, type: 'file' as const })),
        },
        {
          name: 'TRANSCRIPTS',
          type: 'folder',
          children: promptFiles.transcripts.map((file) => ({ name: file.name, type: 'file' as const })),
        },
        {
          name: 'FINAL BRD',
          type: 'folder',
          children: activeProject?.pdfName ? [{ name: activeProject.pdfName, type: 'file' as const }] : [],
        },
      ],
    },
  ]

  const activeDocumentText = selectedStructure
    ? (structureDescriptions[selectedStructure.id] || '')
    : workspaceDraft

  const splitDocumentPages = (text: string) => {
    const charsPerPage = 2200
    if (!text) return ['']

    const explicitPages = text.includes('\f') ? text.split('\f') : [text]
    const pages: string[] = []

    for (const block of explicitPages) {
      const content = block.trim()
      if (!content) {
        pages.push('')
        continue
      }

      for (let index = 0; index < content.length; index += charsPerPage) {
        pages.push(content.slice(index, index + charsPerPage))
      }
    }

    return pages.length > 0 ? pages : ['']
  }

  const paginatedDocument = splitDocumentPages(activeDocumentText)

  const updateActiveDocument = (value: string) => {
    if (selectedStructure) {
      setStructureDescriptions((prev) => ({
        ...prev,
        [selectedStructure.id]: value,
      }))
      return
    }

    setWorkspaceDraft(value)
  }

  const handleDocumentPageChange = (pageIndex: number, pageValue: string) => {
    const updatedPages = [...paginatedDocument]
    updatedPages[pageIndex] = pageValue
    updateActiveDocument(updatedPages.join(''))
  }

  const updateSelectedInstruction = (value: string) => {
    if (!selectedStructure) return
    setStructureInstructions((prev) => ({
      ...prev,
      [selectedStructure.id]: value,
    }))
  }

  const handleRefineSelectedSection = async () => {
    if (!activeProject || !selectedStructure) return

    const instruction = (structureInstructions[selectedStructure.id] || '').trim()
    if (!instruction) {
      alert('Add AI instructions before applying changes.')
      return
    }

    setIsRefiningSection(true)
    try {
      const response = await requestWithFallback(`/projects/${activeProject.id}/toc/refine`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sectionTitle: selectedStructure.title,
          currentDescription: structureDescriptions[selectedStructure.id] || '',
          instruction,
        }),
      })

      if (!response.ok) {
        const message = await response.text()
        alert(`Failed to refine section: ${message || 'Unknown error'}`)
        return
      }

      const data = (await response.json()) as TocRefineResponse
      setStructureDescriptions((prev) => ({
        ...prev,
        [selectedStructure.id]: data.description,
      }))
      setSectionReviewState((prev) => ({
        ...prev,
        [selectedStructure.id]: 'edited',
      }))
    } catch {
      alert(backendErrorMessage)
    } finally {
      setIsRefiningSection(false)
    }
  }

  const handleApproveSelectedSection = () => {
    if (!selectedStructure) return
    setSectionReviewState((prev) => ({
      ...prev,
      [selectedStructure.id]: 'approved',
    }))
  }

  const handleAddStructure = () => {
    const title = newStructureTitle.trim()
    if (!title) return

    const nextItems = [
      ...structureItems,
      {
        id: `toc-${Date.now()}-${structureItems.length + 1}`,
        number: `${structureItems.length + 1}.`,
        title,
      },
    ]

    setStructureItems(nextItems)
    syncTocMaps(nextItems)

    const lastId = nextItems[nextItems.length - 1].id
    setStructureDescriptions((prev) => ({
      ...prev,
      [lastId]: newStructureDescription.trim(),
    }))

    setShowAddStructure(false)
    setNewStructureTitle('')
    setNewStructureDescription('')
  }

  const buildVersionSnapshot = () => {
    if (!activeProject) return null

    const promptSnapshot = (Object.keys(promptFiles) as PromptType[]).reduce(
      (acc, key) => ({
        ...acc,
        [key]: promptFiles[key].map((file) => file.name),
      }),
      {} as Record<PromptType, string[]>,
    )

    return {
      project: activeProject,
      tocDraft,
      structureItems,
      structureDescriptions,
      structureInstructions,
      promptFiles: promptSnapshot,
    }
  }

  const handleSaveVersion = async (source: VersionSource) => {
    if (!activeProject) return

    const snapshot = buildVersionSnapshot()
    if (!snapshot) return

    setIsSavingVersion(true)
    try {
      const response = await requestWithFallback(`/projects/${activeProject.id}/versions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source,
          createdBy: createdByValue,
          snapshot,
        }),
      })

      if (!response.ok) {
        alert('Failed to save version. Please check backend logs.')
        return
      }

      const saved = (await response.json()) as ProjectVersion
      setProjectVersions((current) => [saved, ...current])
      alert('Version saved successfully.')
    } catch {
      alert(backendErrorMessage)
    } finally {
      setIsSavingVersion(false)
    }
  }

  const handleOpenHistory = async () => {
    if (!activeProject) return

    setIsLoadingHistory(true)
    try {
      const response = await requestWithFallback(`/projects/${activeProject.id}/versions`)
      if (!response.ok) {
        alert('Failed to load project history.')
        return
      }

      const versions = (await response.json()) as ProjectVersion[]
      setProjectVersions(versions)
      setShowHistoryModal(true)
    } catch {
      alert(backendErrorMessage)
    } finally {
      setIsLoadingHistory(false)
    }
  }

  const handleRestoreVersion = (version: ProjectVersion) => {
    const snapshot = version.snapshot

    setTocDraft(snapshot.tocDraft || '')
    setStructureItems(snapshot.structureItems || [])
    setStructureDescriptions(snapshot.structureDescriptions || {})
    setStructureInstructions(snapshot.structureInstructions || {})
    setSectionReviewState({})

    if ((snapshot.structureItems || []).length > 0) {
      setSelectedStructureId(snapshot.structureItems[0].id)
    } else {
      setSelectedStructureId(null)
    }

    if (snapshot.promptFiles) {
      const restored: PromptFileMap = {
        mom: (snapshot.promptFiles.mom || []).map((name) => toMockFile(name)),
        drafts: (snapshot.promptFiles.drafts || []).map((name) => toMockFile(name)),
        transcripts: (snapshot.promptFiles.transcripts || []).map((name) => toMockFile(name)),
        chats: (snapshot.promptFiles.chats || []).map((name) => toMockFile(name)),
      }
      setPromptFiles(restored)
    }

    setShowHistoryModal(false)
    setShowTocModal(true)
  }

  return (
    <main className="auth-page">
      <div className="dotgrid-bg">
        <DotGrid
          dotSize={16}
          gap={32}
          baseColor="#1f2937"
          activeColor="#9ca3af"
          proximity={150}
          speedTrigger={100}
          shockRadius={250}
          shockStrength={0.5}
          maxSpeed={5000}
          resistance={750}
          returnDuration={1.5}
        />
      </div>

      <div className="auth-content">
      <Show when="signed-out">
        <div className="login-particles-wrap">
          <Particles
            particleColors={["#ffffff"]}
            particleCount={200}
            particleSpread={10}
            speed={0.1}
            particleBaseSize={100}
            moveParticlesOnHover
            alphaParticles={false}
            disableRotation={false}
            pixelRatio={1}
          />
          <div className="login-signin-layer">
            <SignIn />
          </div>
        </div>
      </Show>

      <Show when="signed-in">
        <section className="transition-shell">
          <AnimatePresence mode="wait" initial={false}>
          {activeProject ? (
            <motion.div
              key="workspace-view"
              className="workspace-shell"
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -18 }}
              transition={{ duration: 0.26, ease: 'easeInOut' }}
            >
              <nav className="workspace-navbar">
                <div className="workspace-brand">
                  SDLC Studio <span>Enterprise</span>
                </div>
                <div className="workspace-user">
                  <div className="workspace-user-meta">
                    <strong>{createdByValue}</strong>
                    <small>Admin</small>
                  </div>
                  <UserButton />
                </div>
              </nav>

              <div className="workspace-container">
                <div className="project-details-bar">
                  <div className="workspace-input">
                    <label>Project Name</label>
                    <input type="text" value={activeProject.name} readOnly />
                  </div>
                  <div className="workspace-input">
                    <label>Created By</label>
                    <input type="text" value={activeProject.createdBy} readOnly />
                  </div>
                  <div className="workspace-input">
                    <label>Field</label>
                    <input type="text" value={activeProject.field} readOnly />
                  </div>
                  <div className="workspace-input">
                    <label>PDF</label>
                    <input type="text" value={activeProject.pdfName} readOnly />
                  </div>
                  <div className="workspace-actions">
                    <button
                      type="button"
                      className="btn-action"
                      onClick={() => void handleSaveVersion('workspace')}
                      disabled={isSavingVersion}
                    >
                      {isSavingVersion ? 'Saving...' : 'Save Version'}
                    </button>
                    <button
                      type="button"
                      className="btn-action"
                      onClick={() => void handleOpenHistory()}
                      disabled={isLoadingHistory}
                    >
                      {isLoadingHistory ? 'Loading...' : 'History'}
                    </button>
                    <button type="button" className="btn-action">Download BRD</button>
                    <button type="button" className="btn-action btn-back" onClick={handleBackToDashboard}>
                      Back
                    </button>
                  </div>
                </div>

                <div className="workspace-main">
                  <aside className={`sidebar left ${isLeftSidebarCollapsed ? 'collapsed' : ''}`}>
                    <div className="sidebar-top-actions">
                      <button
                        type="button"
                        className="sidebar-toggle"
                        onClick={() => setIsLeftSidebarCollapsed((current) => !current)}
                      >
                        {isLeftSidebarCollapsed ? 'Expand' : 'Collapse'}
                      </button>
                    </div>

                    {!isLeftSidebarCollapsed && (
                      <>
                    <div className="left-sidebar-content">
                    <div className="section-title nav-title">Navigation</div>
                    <button
                      type="button"
                      className="action-btn toc-toggle"
                      onClick={() => setShowTocModal(true)}
                    >
                      {isGeneratingToc ? 'Generating...' : 'Generate TOC'}
                    </button>

                    <div className="chat-section">
                      <div className="section-title">Chats</div>
                      <button
                        type="button"
                        className="action-btn chat-tab-btn"
                        onClick={() => setIsChatPanelOpen((current) => !current)}
                      >
                        <span className="chat-tab-default">Chats</span>
                        <span className="chat-tab-hover">{isChatPanelOpen ? 'Close chat' : '+ New chat'}</span>
                      </button>
                    </div>

                    <div className="guided-header">GUIDED PROMPTS</div>
                    <div className="prompts-container">
                      {([
                        { type: 'drafts', label: 'PRE DOCUMENTS' },
                        { type: 'mom', label: 'MINUTERS OF MEETING' },
                        { type: 'transcripts', label: 'TRANSCRIPTS' },
                      ] as Array<{ type: PromptType; label: string }>).map(({ type, label }, index) => (
                        <div
                          key={type}
                          className={`prompt-card ${promptFiles[type].length > 0 ? 'uploaded' : ''}`}
                          onClick={() => setShowPromptUploadFor(type)}
                        >
                          <div className="prompt-title">
                            <span>{index + 1}. {label}</span>
                            <span className={`status-btn ${promptFiles[type].length > 0 ? 'uploaded' : ''}`} />
                          </div>
                          {promptFiles[type].length > 0 && (
                            <div className="file-badges">
                              {promptFiles[type].map((file) => (
                                <div key={`${type}-${file.name}`} className="file-badge" onClick={(event) => event.stopPropagation()}>
                                  <span className="file-name">{file.name}</span>
                                  <button
                                    type="button"
                                    className="delete-file"
                                    onClick={() => removePromptFile(type, file.name)}
                                  >
                                    x
                                  </button>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>

                    <div className="guided-header">DOCUMENT STRUCTURE</div>
                    <div className="structure-list">
                      {structureItems.length === 0 ? (
                        <div className="structure-empty">No structure generated yet.</div>
                      ) : (
                        structureItems.map((item) => (
                          <button
                            key={item.id}
                            type="button"
                            className={`structure-item ${selectedStructure?.id === item.id ? 'active' : ''}`}
                            onClick={() => setSelectedStructureId(item.id)}
                          >
                            <span className="structure-number">{item.number}</span>
                            <span className="structure-title">{item.title}</span>
                          </button>
                        ))
                      )}
                    </div>

                    <button
                      type="button"
                      className="action-btn launch-btn"
                      onClick={() => void handleGenerateBrd()}
                      disabled={isGeneratingBrd}
                    >
                      {isGeneratingBrd ? 'Generating BRD...' : 'Launch'}
                    </button>
                    </div>
                      </>
                    )}
                  </aside>

                  <main className="editor-pane">
                    <div className="editor-stack">
                      <AnimatePresence>
                        {isChatPanelOpen && (
                          <motion.section
                            className="workspace-chat-panel"
                            initial={{ opacity: 0, y: -12, height: 0 }}
                            animate={{ opacity: 1, y: 0, height: 44 }}
                            exit={{ opacity: 0, y: -8, height: 0 }}
                            transition={{ duration: 0.24 }}
                          >
                            <div className="workspace-chat-input-row">
                              <input
                                type="text"
                                value={chatDraft}
                                onChange={(event) => setChatDraft(event.target.value)}
                                onKeyDown={(event) => {
                                  if (event.key === 'Enter') {
                                    event.preventDefault()
                                    handleSendChatMessage()
                                  }
                                }}
                              />
                              <button type="button" onClick={handleSendChatMessage}>Send</button>
                            </div>
                          </motion.section>
                        )}
                      </AnimatePresence>

                      <div className="docs-scroll-stage" aria-label="Document pages">
                        <div className="docs-pages">
                          {paginatedDocument.map((pageText, index) => (
                            <article key={`doc-page-${index + 1}`} className="doc-page-sheet">
                              <textarea
                                className="doc-page-editor"
                                value={pageText}
                                onChange={(event) => handleDocumentPageChange(index, event.target.value)}
                                aria-label={`Document page ${index + 1}`}
                              />
                            </article>
                          ))}
                        </div>
                      </div>
                    </div>
                  </main>

                  <aside className={`sidebar right ${isRightSidebarCollapsed ? 'collapsed' : ''}`}>
                    {!isRightSidebarCollapsed && (
                      <div className="sidebar-content">
                        <div className="repositories-heading">Repositories</div>
                        <div className="file-tree-panel">
                          {rightPanelTreeData.map((item) => (
                            <FileTreeItem key={item.name} item={item} autoOpen />
                          ))}
                        </div>
                      </div>
                    )}
                  </aside>
                </div>

                {showPromptUploadFor && (
                  <div className="modal-overlay" onClick={() => setShowPromptUploadFor(null)}>
                    <div className="modal-content modal-content-small upload-modal" onClick={(event) => event.stopPropagation()}>
                      <div className="modal-header upload-modal-header">
                        <div className="upload-modal-title-wrap">
                          <span className="upload-modal-kicker">Guided Prompt Upload</span>
                          <h3>Upload Files for {showPromptUploadFor.toUpperCase()}</h3>
                        </div>
                        <button type="button" className="btn-cancel upload-close-btn" onClick={() => setShowPromptUploadFor(null)}>
                          Close
                        </button>
                      </div>
                      <div className="modal-body upload-modal-body">
                        <p className="upload-modal-subtitle">
                          Add supporting docs for this section. These files are used in BRD generation.
                        </p>
                        <label className="upload-zone upload-zone-dark" htmlFor="prompt-file-input">
                          <span className="upload-zone-icon">+</span>
                          <strong>Click to Upload</strong>
                          <span>PDF, DOCX, XLSX, TXT, CSV</span>
                          <small>Single file per click. You can upload multiple times.</small>
                        </label>
                        <input
                          id="prompt-file-input"
                          type="file"
                          accept=".pdf,.doc,.docx,.xls,.xlsx,.txt,.csv"
                          onChange={handlePromptFileSelected}
                          style={{ display: 'none' }}
                        />
                      </div>
                    </div>
                  </div>
                )}

                {showTocModal && (
                  <div className="modal-overlay" onClick={() => setShowTocModal(false)}>
                    <div className="modal-content modal-large" onClick={(event) => event.stopPropagation()}>
                      <div className="modal-header">
                        <h3>Project Context &amp; Structure</h3>
                        <div className="modal-header-actions">
                          <button
                            type="button"
                            className="btn-header-action"
                            onClick={() => void handleSaveVersion('toc')}
                            disabled={isSavingVersion}
                          >
                            {isSavingVersion ? 'Saving...' : 'Save Version'}
                          </button>
                          <button
                            type="button"
                            className="btn-header-action"
                            onClick={() => void handleOpenHistory()}
                            disabled={isLoadingHistory}
                          >
                            {isLoadingHistory ? 'Loading...' : 'History'}
                          </button>
                          <button type="button" className="btn-cancel" onClick={() => setShowTocModal(false)}>
                            Close
                          </button>
                        </div>
                      </div>
                      <div className="modal-body">
                        <div className="toc-grid">
                          <div className="toc-col">
                            <h4>Proposed Structure</h4>
                            <p className="subtitle">Click to select a section</p>

                            {isGeneratingToc ? (
                              <div className="empty-structure">
                                <div className="spinner" />
                                <p>Generating structure...</p>
                              </div>
                            ) : structureItems.length > 0 ? (
                              <>
                                <div className="structure-buttons">
                                  {structureItems.map((item) => (
                                    <button
                                      key={item.id}
                                      type="button"
                                      className={`structure-btn ${selectedStructure?.id === item.id ? 'active' : ''}`}
                                      onClick={() => setSelectedStructureId(item.id)}
                                    >
                                      <span className="btn-number">{item.number}</span>
                                      <span className="btn-title">{item.title}</span>
                                      {sectionReviewState[item.id] && (
                                        <span
                                          className={`toc-status-dot ${sectionReviewState[item.id] === 'approved' ? 'approved' : 'edited'}`}
                                          aria-label={sectionReviewState[item.id] === 'approved' ? 'Approved' : 'AI edited'}
                                        />
                                      )}
                                    </button>
                                  ))}
                                </div>

                                <div className="add-section-wrap">
                                  <button
                                    type="button"
                                    className="btn-secondary add-section-btn"
                                    onClick={() => setShowAddStructure((current) => !current)}
                                  >
                                    Add Section
                                  </button>

                                  {showAddStructure && (
                                    <div className="add-section-form">
                                      <input
                                        type="text"
                                        placeholder="Structure name"
                                        value={newStructureTitle}
                                        onChange={(event) => setNewStructureTitle(event.target.value)}
                                      />
                                      <textarea
                                        placeholder="Description"
                                        rows={3}
                                        value={newStructureDescription}
                                        onChange={(event) => setNewStructureDescription(event.target.value)}
                                      />
                                      <button
                                        type="button"
                                        className="btn-submit add-section-save"
                                        onClick={handleAddStructure}
                                        disabled={!newStructureTitle.trim()}
                                      >
                                        Save Section
                                      </button>
                                    </div>
                                  )}
                                </div>
                              </>
                            ) : (
                              <div className="empty-structure">
                                <p>Click Suggest Structure to generate sections.</p>
                              </div>
                            )}
                          </div>

                          <div className="toc-col">
                            <h4>Section Description</h4>
                            <p className="subtitle">
                              {selectedStructure ? `Description for: ${selectedStructure.title}` : 'Select a section'}
                            </p>
                            <motion.div
                              key={selectedStructure?.id || 'empty-section'}
                              className="toc-section-preview"
                              initial={{ opacity: 0, y: 8 }}
                              animate={{ opacity: 1, y: 0 }}
                              transition={{ duration: 0.2 }}
                            >
                              <textarea
                                rows={10}
                                value={selectedStructure ? (structureDescriptions[selectedStructure.id] || '') : ''}
                                placeholder={selectedStructure ? 'Section content will appear here...' : 'Select a section first...'}
                                readOnly
                                className="toc-readonly"
                              />
                            </motion.div>
                          </div>

                          <div className="toc-col">
                            <h4>AI Instructions</h4>
                            <p className="subtitle">
                              {selectedStructure ? `Instructions for: ${selectedStructure.title}` : 'Select a section'}
                            </p>
                            <textarea
                              rows={10}
                              value={selectedStructure ? (structureInstructions[selectedStructure.id] || '') : ''}
                              onChange={(event) => updateSelectedInstruction(event.target.value)}
                              onKeyDown={(event) => {
                                if (event.key === 'Enter' && !event.shiftKey) {
                                  event.preventDefault()
                                  void handleRefineSelectedSection()
                                }
                              }}
                              placeholder={selectedStructure ? 'Type instruction and press Enter to apply (Shift+Enter for newline)...' : 'Select a section first...'}
                              disabled={!selectedStructure}
                            />

                            <div className="toc-instruction-actions">
                              <button
                                type="button"
                                className="btn-cancel toc-apply-btn"
                                onClick={() => void handleRefineSelectedSection()}
                                disabled={!selectedStructure || isRefiningSection || !(structureInstructions[selectedStructure?.id || ''] || '').trim()}
                              >
                                {isRefiningSection ? 'Applying...' : 'Apply Instruction'}
                              </button>
                              <button
                                type="button"
                                className="btn-header-action toc-approve-btn"
                                onClick={handleApproveSelectedSection}
                                disabled={!selectedStructure}
                              >
                                Approve Section
                              </button>
                            </div>

                            {isRefiningSection && (
                              <div className="toc-thinking" role="status" aria-live="polite">
                                <span className="spinner" />
                                <span>AI is refining this section...</span>
                              </div>
                            )}
                          </div>
                        </div>

                        <div className="modal-footer toc-footer">
                          <button type="button" className="btn-cancel toc-suggest-btn" onClick={() => void handleSuggestToc()}>
                            {isGeneratingToc ? 'Generating...' : 'Suggest Structure'}
                          </button>
                          <button type="button" className="btn-submit" onClick={applyTocStructure}>
                            Generate TOC
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {showHistoryModal && (
                  <div className="modal-overlay" onClick={() => setShowHistoryModal(false)}>
                    <div className="modal-content history-modal" onClick={(event) => event.stopPropagation()}>
                      <div className="modal-header">
                        <h3>Version History</h3>
                        <button type="button" className="btn-cancel" onClick={() => setShowHistoryModal(false)}>
                          Close
                        </button>
                      </div>
                      <div className="modal-body">
                        {projectVersions.length === 0 ? (
                          <div className="history-empty">No versions saved yet.</div>
                        ) : (
                          <div className="history-list">
                            {projectVersions.map((version) => (
                              <article key={version.id} className="history-item">
                                <div className="history-item-top">
                                  <span className={`history-badge history-badge-${version.source}`}>
                                    {version.source === 'workspace' ? 'Workspace' : 'TOC Modal'}
                                  </span>
                                  <strong>Version #{version.id}</strong>
                                </div>
                                <p>
                                  Saved by {version.createdBy} on {new Date(version.createdOn).toLocaleString()}
                                </p>
                                <button
                                  type="button"
                                  className="btn-header-action history-restore-btn"
                                  onClick={() => handleRestoreVersion(version)}
                                >
                                  Restore
                                </button>
                              </article>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </motion.div>
          ) : (
            <motion.div
              key="collections-view"
              className="collections-shell"
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 18 }}
              transition={{ duration: 0.26, ease: 'easeInOut' }}
            >
            <div className="collections-layout">
              <aside className="collections-sidebar">
                <div className="collections-logo">SDLC Studio</div>
                <div className="collections-menu">
                  <button type="button" className="collections-menu-item collections-menu-item--active">
                    Projects
                  </button>
                </div>
              </aside>

              <div className="collections-main">
                <div className="collections-topbar">
                  <div className="collections-breadcrumb">Collections / Projects</div>
                  <div className="collections-top-actions">
                    <span className="collections-dot" />
                    <span className="collections-dot" />
                    <span className="collections-dot" />
                    <UserButton />
                  </div>
                </div>

                <div className="collections-content">
                  <div className="collections-header-row">
                    <div>
                      <h2 className="collections-title">Projects</h2>
                      <p className="collections-subtitle">Manage and organize your project sources</p>
                    </div>

                    <motion.button
                      type="button"
                      className="collections-add-btn"
                      onClick={() => setShowProjectForm(true)}
                      initial="rest"
                      whileHover="hover"
                      animate="rest"
                    >
                      <motion.span
                        className="collections-add-circle"
                        variants={{
                          rest: { width: 20 },
                          hover: { width: 20 },
                        }}
                        transition={{ duration: 0.4, ease: 'easeInOut' }}
                      >
                        <span className="collections-add-arrow">+</span>
                      </motion.span>

                      <motion.span
                        className="collections-add-text"
                        variants={{
                          rest: { x: 0, opacity: 0.72 },
                          hover: { x: 4, opacity: 1 },
                        }}
                        transition={{ duration: 0.3 }}
                      >
                        New Project
                      </motion.span>
                    </motion.button>
                  </div>

                  <input className="collections-search" placeholder="Search projects" type="text" readOnly />

                  {isLoading ? (
                    <div className="loading" style={{ height: '340px' }}>
                      <div>
                        <div className="spinner" style={{ width: '36px', height: '40px', margin: '0 auto 10px' }} />
                        <p>Loading projects...</p>
                      </div>
                    </div>
                  ) : projects.length === 0 ? (
                    <div className="empty-state">
                      <p>No projects found</p>
                    </div>
                  ) : (
                    <div className="collections-card-grid">
                      {projects.map((project) => (
                        <TiltedCard
                          key={project.id}
                          imageSrc={PROJECT_CARD_IMAGE}
                          altText={`${project.name} project card`}
                          captionText={project.name}
                          containerHeight="250px"
                          containerWidth="100%"
                          imageHeight="250px"
                          imageWidth="100%"
                          rotateAmplitude={12}
                          scaleOnHover={1.05}
                          showMobileWarning={false}
                          showTooltip
                          displayOverlayContent
                          overlayContent={
                            <article className="collections-card collections-card-overlay">
                              <div className="collections-card-top">
                                <h3>{project.name}</h3>
                                <span className="collections-card-badge">Private</span>
                              </div>
                              <p className="collections-card-desc">{project.description || 'No description available'}</p>
                              <p className="collections-card-meta">Created by {project.createdBy}</p>
                              <div className="collections-card-actions">
                                <button type="button" className="collections-open-btn" onClick={() => handleOpenProject(project)}>
                                  Open Workspace
                                </button>
                                <button
                                  type="button"
                                  className="collections-delete-btn"
                                  onClick={() => handleDeleteProject(project.id)}
                                  disabled={deletingId === project.id}
                                >
                                  {deletingId === project.id ? 'Deleting...' : 'Delete'}
                                </button>
                              </div>
                            </article>
                          }
                        />
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
            </motion.div>
          )}
          </AnimatePresence>

          {showProjectForm && (
            <div className="modal-overlay" onClick={() => setShowProjectForm(false)}>
              <div className="modal-content modal-project-create" onClick={(event) => event.stopPropagation()}>
                <div className="modal-header">
                  <h3>Create New Project</h3>
                  <button type="button" className="btn-cancel" onClick={() => setShowProjectForm(false)}>
                    Close
                  </button>
                </div>

                <form className="modal-body create-project-form" onSubmit={handleCreateProject}>
                  <div className="form-group">
                    <label>Name of Project</label>
                    <input
                      type="text"
                      value={projectName}
                      onChange={(event) => setProjectName(event.target.value)}
                      required
                    />
                  </div>

                  <div className="form-group">
                    <label>Created By</label>
                    <input type="text" value={createdByValue} readOnly />
                  </div>

                  <div className="form-row">
                    <div className="form-group">
                      <label>Field</label>
                      <select
                        value={projectField}
                        onChange={(event) => setProjectField(event.target.value as 'IT' | 'Finance')}
                        required
                      >
                        <option value="IT">IT</option>
                        <option value="Finance">Finance</option>
                      </select>
                    </div>

                    <div className="form-group">
                      <label>Upload PDF</label>
                      <input
                        type="file"
                        accept="application/pdf,.pdf"
                        onChange={(event) => setProjectFile(event.target.files?.[0] ?? null)}
                        required
                      />
                    </div>
                  </div>

                  <div className="form-group">
                    <label>Description</label>
                    <textarea
                      value={description}
                      onChange={(event) => setDescription(event.target.value)}
                      rows={4}
                      required
                    />
                  </div>

                  <div className="modal-footer">
                    <button type="button" className="btn-cancel" onClick={() => setShowProjectForm(false)} disabled={isCreating}>
                      Cancel
                    </button>
                    <button type="submit" className="btn-submit" disabled={isCreating}>
                      {isCreating ? 'Creating...' : 'Create Project'}
                    </button>
                  </div>
                </form>
              </div>
            </div>
          )}
        </section>
      </Show>
      </div>
    </main>
  )
}

export default App
