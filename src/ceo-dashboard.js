const STATUSES = ['To Do', 'In Progress', 'Review', 'Done']
const DEFAULT_PROJECTS = [
  { id: 'nathilco', name: 'Natheelco', color: '#1e40af', parent: '' },
  { id: 'hajiss', name: 'Hajiss Café', color: '#b45309', parent: 'nathilco' },
  { id: 'odin', name: 'Odun Pide', color: '#7c3aed', parent: 'nathilco' },
  { id: 'ghalia', name: 'Ghalia', color: '#db2777', parent: 'nathilco' },
  { id: 'danny', name: 'Dani Designs', color: '#0891b2', parent: 'nathilco' },
]
const DEFAULT_WEIGHTS = { ontime: 35, target: 20, overdue: 15, volume: 30 }

function normalize(value) {
  return String(value ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

function collectionRows(store, name) {
  return Object.entries(store.documents?.[name] || {}).map(([id, entry]) => ({
    ...(entry?.data || {}),
    id,
  }))
}

function dueEnd(date) {
  if (!date) return Infinity
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return Number.NaN
  const timestamp = new Date(`${date}T23:59:59`).getTime()
  return Number.isFinite(timestamp) ? timestamp : Number.NaN
}

function isLate(task, now) {
  return task.status !== 'Done' && Boolean(task.due) && dueEnd(task.due) < now
}

function clickupTasks(snapshot, projects) {
  const membersById = new Map((snapshot?.members || []).map((member) => [String(member.id), member.name]))
  return (snapshot?.tasks || [])
    .filter((task) => task && typeof task === 'object')
    .map((task) => {
      const rawStatus = typeof task.status === 'string' ? task.status : task.status?.status || ''
      const status = rawStatus.toLowerCase()
      const type = task.status_type || task.status?.type || ''
      const priority = typeof task.priority === 'string' ? task.priority : task.priority?.priority
      const done = type === 'done' || type === 'closed' || (!type && /complete|closed|done/.test(status))
      const assignees = (Array.isArray(task.assignees) ? task.assignees : [])
        .map(
          (person) =>
            membersById.get(String(person.id)) ||
            person.username ||
            person.email ||
            person.name ||
            String(person.id || '')
        )
        .filter(Boolean)
      const project = [task.list?.name, task.folder?.name, task.space?.name]
        .map((name) =>
          projects.find(
            (candidate) => normalize(candidate.name) === normalize(name) || normalize(candidate.id) === normalize(name)
          )
        )
        .find(Boolean)
      const dueTimestamp = Number(task.due_date)
      return {
        id: `cu:${task.id}`,
        externalId: task.id,
        url: task.url || '',
        title: task.name || '',
        description: task.description || task.text_content || '',
        project: project?.id || task.list?.name || 'ClickUp',
        assignee: assignees[0] || '',
        assignees,
        status: done
          ? 'Done'
          : type === 'open' || status === 'to do' || status === 'open'
            ? 'To Do'
            : /review|approv|qa/.test(status)
              ? 'Review'
              : 'In Progress',
        rawStatus,
        statusColor: task.status_color || task.status?.color,
        due: Number.isFinite(dueTimestamp) && dueTimestamp
          ? new Date(dueTimestamp).toLocaleDateString('en-CA')
          : '',
        priority: typeof priority === 'string' && priority ? priority[0].toUpperCase() + priority.slice(1) : 'Normal',
        tags: (Array.isArray(task.tags) ? task.tags : []).map((tag) => tag?.name).filter(Boolean),
        doneAt: Number(task.date_closed) || 0,
        space: task.space?.name || '',
        folder: task.folder?.name || '',
        list: task.list?.name || '',
        created: Number(task.date_created) || 0,
        updated: Number(task.date_updated) || 0,
        parent: task.parent || '',
        demo: false,
        source: 'clickup',
      }
    })
}

function makeProjectScope(tasks, projects) {
  return (projectId, source = tasks) =>
    source.filter((task) => {
      if (!projectId) return true
      let project = projects.find((candidate) => candidate.id === task.project)
      const visited = new Set()
      while (project && !visited.has(project.id)) {
        if (project.id === projectId) return true
        visited.add(project.id)
        project = projects.find((candidate) => candidate.id === project.parent)
      }
      return task.project === projectId
    })
}

export function buildCeoDashboard(store, { projectId = '', assignee = '', status = '', now = Date.now() } = {}) {
  const config = store.documents?.config?.main?.data || {}
  const configuredProjects = Array.isArray(config.projects) ? config.projects : DEFAULT_PROJECTS
  const tasks = collectionRows(store, 'tasks')
  const history = collectionRows(store, 'history')
  const snapshot = store.documents?.integrations?.clickup?.data || {}
  const members = Array.isArray(snapshot.members) ? snapshot.members : []
  const rawClickupTasks = Array.isArray(snapshot.tasks) ? snapshot.tasks : []
  const clickup = clickupTasks(snapshot, configuredProjects)

  const normalizedHistory = new Map()
  for (const item of history) {
    const key = normalize(item.title)
    if (key && !normalizedHistory.has(key)) normalizedHistory.set(key, item)
  }
  const usedHistory = new Set()
  const creditedClickup = clickup.map((task) => {
    const imported = normalizedHistory.get(normalize(task.title))
    const rule = config.credit || {}
    const matchesRule =
      (rule.list && [task.list, task.folder, task.space].some((value) => normalize(value) === normalize(rule.list))) ||
      (rule.tag && task.tags.some((tag) => normalize(tag) === normalize(rule.tag))) ||
      (rule.before && task.created && task.created <= dueEnd(rule.before))
    if (!imported && !(config.credit?.name && matchesRule)) return task
    if (imported) usedHistory.add(normalize(task.title))
    const owner = imported?.assignee || config.credit?.name || ''
    return {
      ...task,
      assignee: owner,
      assignees: owner ? [owner] : [],
      status: imported?.status === 'Done' ? 'Done' : task.status,
      doneAt: imported?.doneAt || task.doneAt,
      due: task.due || imported?.due || '',
      credited: true,
      imported,
    }
  })
  const importedRows = history
    .filter((item) => !usedHistory.has(normalize(item.title)))
    .map((item) => ({
      id: `history:${item.id}`,
      title: item.title,
      project: item.project || 'nathilco',
      assignee: item.assignee || '',
      assignees: item.assignee ? [item.assignee] : [],
      status: item.status || 'Done',
      priority: item.priority || 'Normal',
      due: item.due || '',
      doneAt: item.doneAt || 0,
      note: item.note || '',
      hist: true,
      tags: ['Google Sheets'],
      source: 'history',
    }))
  const allTasks = [
    ...creditedClickup,
    ...tasks.map((task) => ({
      ...task,
      assignees: task.assignee ? [task.assignee] : [],
      source: 'taskflow',
    })),
    ...importedRows,
  ]
  const knownProjects = new Set(configuredProjects.map((project) => project.id))
  const projects = [
    ...configuredProjects,
    ...new Set([...tasks, ...history].map((task) => task.project).filter((id) => id && !knownProjects.has(id))),
  ].map((project) =>
    typeof project === 'string' ? { id: project, name: project, color: '#64748b', parent: 'nathilco' } : project
  )
  const projectScope = makeProjectScope(allTasks, projects)
  const isWithinSelectedProject = (candidate) => {
    let project = candidate
    const visited = new Set()
    while (project && !visited.has(project.id)) {
      if (project.id === projectId) return true
      visited.add(project.id)
      project = projects.find((item) => item.id === project.parent)
    }
    return false
  }
  const teamTasks = projectScope(projectId).filter((task) =>
    !status || (status === 'Overdue' ? isLate(task, now) : task.status === status)
  )
  const scopedTasks = teamTasks.filter((task) => {
    const matchesAssignee =
      !assignee ||
      (task.assignees || [task.assignee]).some((name) => normalize(name) === normalize(assignee))
    const matchesStatus = !status || (status === 'Overdue' ? isLate(task, now) : task.status === status)
    return matchesAssignee && matchesStatus
  })
  const completedTasks = scopedTasks.filter((task) => task.status === 'Done')
  const onTimeTasks = completedTasks.filter((task) => !task.due || task.doneAt <= dueEnd(task.due))
  const overdueTasks = scopedTasks.filter((task) => isLate(task, now))
  const statusCounts = Object.fromEntries(STATUSES.map((name) => [name, scopedTasks.filter((task) => task.status === name).length]))

  const peopleByKey = new Map()
  for (const name of [
    ...members.map((member) => member.name),
    ...allTasks.flatMap((task) => task.assignees || (task.assignee ? [task.assignee] : [])),
  ]) {
    const label = String(name || '').trim()
    const key = normalize(label)
    if (key && key !== normalize('CEO') && !peopleByKey.has(key)) peopleByKey.set(key, label)
  }
  const staff = [...peopleByKey.values()].sort((left, right) => left.localeCompare(right))
  const busiest = Math.max(
    1,
    ...staff.map((name) =>
      teamTasks.filter((task) =>
        (task.assignees || [task.assignee]).some((owner) => normalize(owner) === normalize(name))
      ).length
    )
  )
  const weights = config.w || DEFAULT_WEIGHTS
  const weightTotal = Object.values(weights).reduce((sum, value) => sum + (+value || 0), 0) || 1
  const target = Math.max(1, Number(config.target) || 1)
  const liveWorkerNames = new Set([
    ...members.map((member) => member.name),
    ...scopedTasks.flatMap((task) => task.assignees || (task.assignee ? [task.assignee] : [])),
  ].map(normalize))
  const employeeKpis = staff
    .map((name) => {
      const owned = teamTasks.filter((task) =>
        (task.assignees || [task.assignee]).some((owner) => normalize(owner) === normalize(name))
      )
      const done = owned.filter((task) => task.status === 'Done')
      const onTime = done.filter((task) => !task.due || task.doneAt <= dueEnd(task.due)).length
      const overdue = owned.filter((task) => isLate(task, now)).length
      const metrics = {
        ontime: done.length ? (onTime / done.length) * 100 : owned.length ? 0 : 100,
        target: Math.min(done.length / target, 1) * 100,
        overdue: owned.length ? (1 - overdue / owned.length) * 100 : 100,
        volume: (owned.length / busiest) * 100,
      }
      const score = owned.length
        ? Object.keys(metrics).reduce((sum, key) => sum + metrics[key] * (+weights[key] || 0), 0) / weightTotal
        : 0
      return {
        name,
        total: owned.length,
        done: done.length,
        open: owned.length - done.length,
        overdue,
        onTime,
        score,
      }
    })
    .filter((row) => liveWorkerNames.has(normalize(row.name)) && (!projectId || row.total > 0))
    .sort((left, right) => right.score - left.score || right.total - left.total)

  const projectProgress = projects
    .filter((project) => project.parent && (!projectId || isWithinSelectedProject(project)))
    .map((project) => {
      const projectTasks = projectScope(project.id)
      return {
        ...project,
        tasks: projectTasks.length,
        done: projectTasks.filter((task) => task.status === 'Done').length,
      }
    })
    .filter((project) => project.tasks > 0)
  const averageKpi = employeeKpis.length
    ? employeeKpis.reduce((sum, row) => sum + row.score, 0) / employeeKpis.length
    : 0

  return {
    generatedAt: new Date(now).toISOString(),
    filters: { project: projectId, assignee, status },
    sources: {
      taskflowTasks: tasks.length,
      historyTasks: history.length,
      clickup: {
        configured: Boolean(process.env.CLICKUP_API_TOKEN),
        stale: Boolean(snapshot.stale || !process.env.CLICKUP_API_TOKEN),
        truncated: Boolean(snapshot.truncated),
        tasks: rawClickupTasks.length,
        members: members.length,
        updatedAt: store.documents?.integrations?.clickup?.updatedAt || '',
      },
    },
    totals: {
      tasks: scopedTasks.length,
      completed: completedTasks.length,
      open: scopedTasks.length - completedTasks.length,
      onTime: onTimeTasks.length,
      onTimeRate: completedTasks.length ? Math.round((onTimeTasks.length / completedTasks.length) * 100) : 0,
      overdue: overdueTasks.length,
      employeeCount: employeeKpis.length,
      teamKpiScore: Math.round(averageKpi),
    },
    statusCounts,
    overdueTasks: overdueTasks.slice(0, 10),
    projectProgress,
    employeeKpis,
    recentTasks: [...scopedTasks]
      .sort((left, right) => (right.updated || right.doneAt || 0) - (left.updated || left.doneAt || 0))
      .slice(0, 10),
  }
}
