import { randomBytes } from 'node:crypto'

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const IBAN_REGEX = /^[A-Z0-9]{15,34}$/i

export function normalizeSerialNumber(value) {
  return String(value || '').trim().toUpperCase()
}

export function validateEmployeeData(data, existingEmployees = [], currentRecordId = null) {
  const errors = []

  const firstName = String(data.firstName || '').trim()
  const lastName = String(data.lastName || '').trim()
  const serialNumber = normalizeSerialNumber(data.serialNumber || data.employeeId)
  const dob = String(data.dob || '').trim()
  const email = String(data.email || '').trim().toLowerCase()

  if (!firstName) errors.push('First name is required.')
  if (!lastName) errors.push('Last name is required.')
  if (!serialNumber) errors.push('Employee serial number is required.')
  if (!dob) errors.push('Date of birth is required.')
  else if (Number.isNaN(Date.parse(dob))) errors.push('Date of birth must be a valid date.')

  if (!email) errors.push('Email address is required.')
  else if (!EMAIL_REGEX.test(email)) errors.push('Please enter a valid email address.')

  // Check unique serial number constraint
  if (serialNumber) {
    const duplicate = existingEmployees.find((emp) => {
      const empId = emp.id
      if (currentRecordId && empId === currentRecordId) return false
      const otherSerial = normalizeSerialNumber(emp.data?.serialNumber || emp.data?.employeeId)
      return otherSerial === serialNumber
    })
    if (duplicate) {
      errors.push(`Employee serial number "${serialNumber}" is already in use by ${duplicate.data?.name || 'another employee'}.`)
    }
  }

  // Validate optional IBAN if provided
  if (data.iban && !IBAN_REGEX.test(String(data.iban).replaceAll(' ', ''))) {
    errors.push('Please enter a valid IBAN (15–34 alphanumeric characters).')
  }

  return {
    valid: errors.length === 0,
    errors,
    sanitized: {
      firstName,
      lastName,
      name: `${firstName} ${lastName}`.trim(),
      serialNumber,
      employeeId: serialNumber,
      dob,
      email,
      phone: String(data.phone || '').trim(),
      foreignOrLocal: ['Foreign', 'Local'].includes(data.foreignOrLocal) ? data.foreignOrLocal : 'Local',
      nationality: String(data.nationality || '').trim(),
      iqamaNumber: String(data.iqamaNumber || '').trim(),
      passportNumber: String(data.passportNumber || '').trim(),
      address: String(data.address || '').trim(),
      position: String(data.position || data.jobTitle || '').trim(),
      jobTitle: String(data.jobTitle || data.position || '').trim(),
      department: String(data.department || '').trim(),
      qualification: String(data.qualification || '').trim(),
      annualHolidayEntitlement: Math.max(0, Number(data.annualHolidayEntitlement ?? data.holidayDays) || 0),
      holidayDays: Math.max(0, Number(data.holidayDays ?? data.annualHolidayEntitlement) || 0),
      openingHolidayBalance: Math.max(0, Number(data.openingHolidayBalance) || 0),
      status: ['Active', 'Inactive', 'On leave'].includes(data.status) ? data.status : 'Active',
      contractType: data.contractType || 'Permanent',
      startDate: String(data.startDate || '').trim(),
      endDate: String(data.endDate || '').trim(),
      workingDays: Array.isArray(data.workingDays)
        ? data.workingDays
        : (data.workingDays ? String(data.workingDays).split(',').map((d) => d.trim()).filter(Boolean) : ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday']),
      monthlySalary: Math.max(0, Number(data.monthlySalary) || 0),
      annualSalary: Math.max(0, Number(data.annualSalary || (Number(data.monthlySalary) ? Number(data.monthlySalary) * 12 : 0)) || 0),
      overtimeRate: Math.max(0, Number(data.overtimeRate) || 0),
      bankName: String(data.bankName || '').trim(),
      accountNumber: String(data.accountNumber || '').trim(),
      iban: String(data.iban || '').trim().replaceAll(' ', '').toUpperCase(),
      routeSwift: String(data.routeSwift || data.routingNumber || '').trim().toUpperCase(),
      routingNumber: String(data.routingNumber || data.routeSwift || '').trim().toUpperCase(),
      swiftCode: String(data.swiftCode || data.routeSwift || '').trim().toUpperCase(),
      bankCountry: String(data.bankCountry || '').trim(),
      company: String(data.company || 'Natheelco').trim(),
      branch: String(data.branch || 'Main').trim(),
      documents: Array.isArray(data.documents) ? data.documents : [],
    },
  }
}

export function computeEmployeeStats(employees) {
  const now = new Date()
  const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)

  let activeCount = 0
  let inactiveCount = 0
  let onLeaveCount = 0
  let newCount = 0

  for (const emp of employees) {
    const status = emp.data?.status || 'Active'
    if (status === 'Active') activeCount++
    else if (status === 'Inactive') inactiveCount++
    else if (status === 'On leave') onLeaveCount++

    const startDate = emp.data?.startDate || emp.createdAt?.slice(0, 10) || ''
    if (startDate && startDate >= ninetyDaysAgo) {
      newCount++
    }
  }

  return {
    total: employees.length,
    active: activeCount,
    inactive: inactiveCount,
    onLeave: onLeaveCount,
    newEmployees: newCount,
  }
}

export async function handleHrEmployeesRequest(req, res, url, user, { readStore, updateStore, json, jsonBody }) {
  if (!user.isAdmin && !user.permissions?.includes('hr')) {
    return json(res, 403, { error: 'Your account does not have access to HR Management.' })
  }

  const method = req.method
  const pathname = url.pathname

  // Extract /api/hr/employees subpath
  // Routes:
  // GET /api/hr/employees
  // POST /api/hr/employees
  // POST /api/hr/employees/import
  // GET /api/hr/employees/:id
  // PUT /api/hr/employees/:id
  // DELETE /api/hr/employees/:id
  // POST /api/hr/employees/:id/documents
  // DELETE /api/hr/employees/:id/documents/:docId

  const subpath = pathname.replace(/^\/api\/hr\/employees\/?/, '')

  // GET /api/hr/employees
  if (method === 'GET' && !subpath) {
    const store = await readStore()
    const allHrDocs = Object.entries(store.documents?.hr || {}).map(([id, item]) => ({
      id,
      ...item.data,
      createdAt: item.data?.createdAt || item.updatedAt,
      updatedAt: item.updatedAt,
    }))

    const employees = allHrDocs.filter((doc) => doc.module === 'employees' && !doc.archivedAt)

    const search = (url.searchParams.get('search') || '').trim().toLowerCase()
    const status = (url.searchParams.get('status') || '').trim()
    const nationality = (url.searchParams.get('nationality') || '').trim().toLowerCase()
    const department = (url.searchParams.get('department') || '').trim().toLowerCase()
    const position = (url.searchParams.get('position') || '').trim().toLowerCase()
    const company = (url.searchParams.get('company') || '').trim()
    const branch = (url.searchParams.get('branch') || '').trim()

    let filtered = employees.filter((emp) => {
      const d = emp.data || {}
      if (company && d.company !== company) return false
      if (branch && d.branch !== branch) return false
      if (status && d.status !== status) return false
      if (nationality && (d.nationality || '').toLowerCase() !== nationality) return false
      if (department && (d.department || '').toLowerCase() !== department) return false
      if (position && (d.position || '').toLowerCase() !== position) return false
      if (search) {
        const text = `${d.name || ''} ${d.serialNumber || ''} ${d.employeeId || ''} ${d.email || ''} ${d.iqamaNumber || ''} ${d.position || ''} ${d.department || ''}`.toLowerCase()
        if (!text.includes(search)) return false
      }
      return true
    })

    const sort = url.searchParams.get('sort') || 'name'
    const order = (url.searchParams.get('order') || 'asc').toLowerCase() === 'desc' ? -1 : 1

    filtered.sort((a, b) => {
      const valA = a.data?.[sort] ?? ''
      const valB = b.data?.[sort] ?? ''
      if (typeof valA === 'number' && typeof valB === 'number') {
        return (valA - valB) * order
      }
      return String(valA).localeCompare(String(valB)) * order
    })

    const stats = computeEmployeeStats(employees)

    const pageParam = url.searchParams.get('page')
    const limitParam = url.searchParams.get('limit')
    if (pageParam && limitParam) {
      const page = Math.max(1, Number(pageParam) || 1)
      const limit = Math.min(100, Math.max(1, Number(limitParam) || 20))
      const total = filtered.length
      const paginated = filtered.slice((page - 1) * limit, page * limit)
      return json(res, 200, {
        employees: paginated,
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
        stats,
      })
    }

    return json(res, 200, {
      employees: filtered,
      total: filtered.length,
      stats,
    })
  }

  // POST /api/hr/employees/import
  if (method === 'POST' && subpath === 'import') {
    const body = await jsonBody(req)
    const items = Array.isArray(body?.employees) ? body.employees : []
    if (!items.length) {
      return json(res, 400, { error: 'Please provide an array of employees to import.' })
    }

    const store = await readStore()
    const existingEmployees = Object.entries(store.documents?.hr || {})
      .map(([id, item]) => ({ id, ...item.data }))
      .filter((doc) => doc.module === 'employees')

    const seenSerials = new Set()
    const importedRecords = []
    const failedRows = []

    for (let index = 0; index < items.length; index++) {
      const row = items[index]
      const serial = normalizeSerialNumber(row.serialNumber || row.employeeId)

      if (seenSerials.has(serial)) {
        failedRows.push({ row: index + 1, serialNumber: serial, error: 'Duplicate serial number in import file.' })
        continue
      }
      seenSerials.add(serial)

      const validation = validateEmployeeData(row, existingEmployees)
      if (!validation.valid) {
        failedRows.push({ row: index + 1, serialNumber: serial, errors: validation.errors })
        continue
      }

      const id = `hr-emp-${Date.now()}-${randomBytes(4).toString('hex')}-${index}`
      const newRecord = {
        id,
        module: 'employees',
        company: validation.sanitized.company,
        branch: validation.sanitized.branch,
        data: validation.sanitized,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }
      importedRecords.push(newRecord)
      existingEmployees.push(newRecord)
    }

    if (importedRecords.length > 0) {
      await updateStore(
        (currentStore) => {
          currentStore.documents.hr ||= {}
          for (const rec of importedRecords) {
            currentStore.documents.hr[rec.id] = { data: rec, updatedAt: rec.updatedAt }
          }
        },
        {
          actorId: user.id,
          actorName: user.name,
          action: 'employee.import',
          collection: 'hr',
          documentId: importedRecords[0]?.id || 'bulk',
          details: { count: importedRecords.length, failedCount: failedRows.length },
        }
      )
    }

    return json(res, 200, {
      success: true,
      importedCount: importedRecords.length,
      failedCount: failedRows.length,
      failedRows,
      imported: importedRecords,
    })
  }

  // POST /api/hr/employees (Create single employee)
  if (method === 'POST' && !subpath) {
    const body = await jsonBody(req)
    const store = await readStore()
    const existingEmployees = Object.entries(store.documents?.hr || {})
      .map(([id, item]) => ({ id, ...item.data }))
      .filter((doc) => doc.module === 'employees')

    const validation = validateEmployeeData(body, existingEmployees)
    if (!validation.valid) {
      return json(res, 400, { error: validation.errors.join(' ') })
    }

    const id = `hr-emp-${Date.now()}-${randomBytes(4).toString('hex')}`
    const record = {
      id,
      module: 'employees',
      company: validation.sanitized.company,
      branch: validation.sanitized.branch,
      data: validation.sanitized,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }

    await updateStore(
      (currentStore) => {
        currentStore.documents.hr ||= {}
        currentStore.documents.hr[id] = { data: record, updatedAt: record.updatedAt }
      },
      {
        actorId: user.id,
        actorName: user.name,
        action: 'employee.create',
        collection: 'hr',
        documentId: id,
        details: { name: record.data.name, serialNumber: record.data.serialNumber },
      }
    )

    return json(res, 201, { employee: record })
  }

  // Operations on /api/hr/employees/:id
  const parts = subpath.split('/')
  const employeeId = parts[0]

  if (employeeId) {
    const store = await readStore()
    const currentDoc = store.documents?.hr?.[employeeId]
    if (!currentDoc || currentDoc.data?.module !== 'employees') {
      return json(res, 404, { error: 'Employee not found.' })
    }

    // GET /api/hr/employees/:id
    if (method === 'GET' && parts.length === 1) {
      return json(res, 200, { employee: { id: employeeId, ...currentDoc.data, updatedAt: currentDoc.updatedAt } })
    }

    // PUT /api/hr/employees/:id
    if ((method === 'PUT' || method === 'PATCH') && parts.length === 1) {
      const body = await jsonBody(req)
      const existingEmployees = Object.entries(store.documents?.hr || {})
        .map(([id, item]) => ({ id, ...item.data }))
        .filter((doc) => doc.module === 'employees')

      const mergedData = { ...currentDoc.data?.data, ...(body.data || body) }
      const validation = validateEmployeeData(mergedData, existingEmployees, employeeId)
      if (!validation.valid) {
        return json(res, 400, { error: validation.errors.join(' ') })
      }

      const updatedRecord = {
        ...currentDoc.data,
        company: validation.sanitized.company,
        branch: validation.sanitized.branch,
        data: validation.sanitized,
        updatedAt: new Date().toISOString(),
      }

      await updateStore(
        (currentStore) => {
          currentStore.documents.hr ||= {}
          currentStore.documents.hr[employeeId] = { data: updatedRecord, updatedAt: updatedRecord.updatedAt }
        },
        {
          actorId: user.id,
          actorName: user.name,
          action: 'employee.update',
          collection: 'hr',
          documentId: employeeId,
          details: { name: updatedRecord.data.name, serialNumber: updatedRecord.data.serialNumber },
        }
      )

      return json(res, 200, { employee: updatedRecord })
    }

    // DELETE /api/hr/employees/:id
    if (method === 'DELETE' && parts.length === 1) {
      await updateStore(
        (currentStore) => {
          delete currentStore.documents?.hr?.[employeeId]
        },
        {
          actorId: user.id,
          actorName: user.name,
          action: 'employee.delete',
          collection: 'hr',
          documentId: employeeId,
          details: { name: currentDoc.data?.data?.name, serialNumber: currentDoc.data?.data?.serialNumber },
        }
      )

      return json(res, 200, { ok: true })
    }

    // POST /api/hr/employees/:id/documents
    if (method === 'POST' && parts[1] === 'documents') {
      const docPayload = await jsonBody(req)
      if (!docPayload.fileId || !docPayload.name) {
        return json(res, 400, { error: 'Document fileId and name are required.' })
      }

      const documentItem = {
        id: `doc-${Date.now()}-${randomBytes(3).toString('hex')}`,
        fileId: docPayload.fileId,
        name: String(docPayload.name).trim(),
        category: docPayload.category || 'Other',
        size: Number(docPayload.size) || 0,
        type: docPayload.type || 'application/octet-stream',
        uploadedAt: new Date().toISOString(),
        url: `/api/files/${encodeURIComponent(docPayload.fileId)}`,
      }

      const updatedRecord = {
        ...currentDoc.data,
        data: {
          ...currentDoc.data.data,
          documents: [...(currentDoc.data.data.documents || []), documentItem],
        },
        updatedAt: new Date().toISOString(),
      }

      await updateStore(
        (currentStore) => {
          currentStore.documents.hr ||= {}
          currentStore.documents.hr[employeeId] = { data: updatedRecord, updatedAt: updatedRecord.updatedAt }
        },
        {
          actorId: user.id,
          actorName: user.name,
          action: 'employee.document.upload',
          collection: 'hr',
          documentId: employeeId,
          details: { docName: documentItem.name, docCategory: documentItem.category },
        }
      )

      return json(res, 201, { document: documentItem, employee: updatedRecord })
    }

    // DELETE /api/hr/employees/:id/documents/:docId
    if (method === 'DELETE' && parts[1] === 'documents' && parts[2]) {
      const docId = parts[2]
      const docs = currentDoc.data?.data?.documents || []
      const targetDoc = docs.find((d) => d.id === docId || d.fileId === docId)

      const remainingDocs = docs.filter((d) => d.id !== docId && d.fileId !== docId)
      const updatedRecord = {
        ...currentDoc.data,
        data: {
          ...currentDoc.data.data,
          documents: remainingDocs,
        },
        updatedAt: new Date().toISOString(),
      }

      await updateStore(
        (currentStore) => {
          currentStore.documents.hr ||= {}
          currentStore.documents.hr[employeeId] = { data: updatedRecord, updatedAt: updatedRecord.updatedAt }
          if (targetDoc?.fileId && currentStore.uploads?.[targetDoc.fileId]) {
            delete currentStore.uploads[targetDoc.fileId]
          }
        },
        {
          actorId: user.id,
          actorName: user.name,
          action: 'employee.document.delete',
          collection: 'hr',
          documentId: employeeId,
          details: { docId, name: targetDoc?.name },
        }
      )

      return json(res, 200, { ok: true, employee: updatedRecord })
    }
  }

  return json(res, 404, { error: 'HR endpoint not found.' })
}
