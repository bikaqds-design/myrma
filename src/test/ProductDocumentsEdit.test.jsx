/**
 * ProductDocumentsEdit.test.jsx — editing an attached document's metadata.
 *
 * This screen could not have worked at all until 20260804. product_documents
 * carried a trigger setting NEW.updated_date on a table whose column is
 * updated_at, so every UPDATE raised; the table had only ever been inserted
 * into and deleted from, which is why nothing noticed. These tests cover the
 * UI, not the trigger — but the reason there was no edit UI to test before is
 * worth stating.
 *
 * The properties pinned here are the ones where being wrong is quiet:
 *
 *  - only CHANGED fields are sent. Sending the whole row would stamp updated_at
 *    on a document nobody edited and make the trail read as if they had;
 *  - a save that fails leaves the form open with the user's text intact, rather
 *    than closing and discarding what they typed;
 *  - the controls are absent entirely without edit permission, rather than
 *    present and failing at the server.
 *
 * i18n echoes the key so an assertion names the exact message.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import React from 'react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k, vars) => (vars ? `${k} ${JSON.stringify(vars)}` : k),
  }),
}))

vi.mock('../lib/snippet', () => ({ buildSnippet: () => null }))
vi.mock('../lib/documentTypes', () => ({
  DOC_TYPES: ['datasheet', 'manual', 'warranty'],
}))

const { DocumentRow } = await import('../components/ProductDocuments.jsx')

const DOC = {
  id: 'doc-1',
  title: 'Cylon Datasheet',
  doc_type: 'datasheet',
  description: 'Original description',
  file_name: 'cylon.pdf',
  file_url: 'https://example.test/cylon.pdf',
  file_size: 2048,
  page_count: 2,
  extraction_status: 'ok',
}

afterEach(cleanup)

/** Open the editor and hand back the fields. */
function openEditor(onSave, doc = DOC) {
  render(<DocumentRow doc={doc} onSave={onSave} onRemove={() => {}} busy={false} />)
  fireEvent.click(screen.getByLabelText(`common.edit ${doc.title}`))
  return {
    title: screen.getByLabelText('documents.title'),
    type: screen.getByLabelText('documents.type'),
    description: screen.getByLabelText('documents.description'),
    save: screen.getByText('common.save'),
  }
}

describe('entering edit mode', () => {
  it('shows the current values, not empty fields', () => {
    const f = openEditor(vi.fn())
    expect(f.title.value).toBe('Cylon Datasheet')
    expect(f.type.value).toBe('datasheet')
    expect(f.description.value).toBe('Original description')
  })

  it('says the file itself cannot be changed here, and names it', () => {
    openEditor(vi.fn())
    expect(screen.getByText(/documents\.editFileFixed/)).toHaveTextContent('cylon.pdf')
  })
})

describe('what gets sent', () => {
  it('sends only the field that changed', async () => {
    const onSave = vi.fn().mockResolvedValue(true)
    const f = openEditor(onSave)

    fireEvent.change(f.title, { target: { value: 'Cylon Datasheet v2' } })
    fireEvent.click(f.save)

    await waitFor(() => expect(onSave).toHaveBeenCalled())
    const [, patch] = onSave.mock.calls[0]
    expect(patch).toEqual({ title: 'Cylon Datasheet v2' })
    // The untouched fields must not ride along.
    expect(patch).not.toHaveProperty('docType')
    expect(patch).not.toHaveProperty('description')
  })

  it('sends several fields when several changed', async () => {
    const onSave = vi.fn().mockResolvedValue(true)
    const f = openEditor(onSave)

    fireEvent.change(f.title, { target: { value: 'Renamed' } })
    fireEvent.change(f.type, { target: { value: 'manual' } })
    fireEvent.click(f.save)

    await waitFor(() => expect(onSave).toHaveBeenCalled())
    expect(onSave.mock.calls[0][1]).toEqual({ title: 'Renamed', docType: 'manual' })
  })

  /**
   * Opening the editor and pressing Save without typing must not write. A
   * no-op UPDATE would still move updated_at, so the record would claim an
   * edit that never happened.
   */
  it('writes nothing when nothing changed', async () => {
    const onSave = vi.fn().mockResolvedValue(true)
    const f = openEditor(onSave)
    fireEvent.click(f.save)
    await waitFor(() => expect(screen.queryByLabelText('documents.title')).toBeNull())
    expect(onSave).not.toHaveBeenCalled()
  })

  it('refuses to save an empty title', async () => {
    const onSave = vi.fn().mockResolvedValue(true)
    const f = openEditor(onSave)
    fireEvent.change(f.title, { target: { value: '   ' } })
    fireEvent.click(f.save)
    expect(onSave).not.toHaveBeenCalled()
    // And the editor stays open rather than silently discarding the edit.
    expect(screen.getByLabelText('documents.title')).toBeTruthy()
  })
})

describe('after saving', () => {
  it('closes the editor when the save succeeded', async () => {
    const onSave = vi.fn().mockResolvedValue(true)
    const f = openEditor(onSave)
    fireEvent.change(f.title, { target: { value: 'New name' } })
    fireEvent.click(f.save)
    await waitFor(() => expect(screen.queryByLabelText('documents.title')).toBeNull())
  })

  /**
   * The failure that would cost someone their work: closing the form on a
   * rejected save discards what they typed and tells them it worked.
   */
  it('keeps the editor open, with the text intact, when the save failed', async () => {
    const onSave = vi.fn().mockResolvedValue(false)
    const f = openEditor(onSave)
    fireEvent.change(f.title, { target: { value: 'Name that will not save' } })
    fireEvent.click(f.save)

    await waitFor(() => expect(onSave).toHaveBeenCalled())
    const field = screen.getByLabelText('documents.title')
    expect(field).toBeTruthy()
    expect(field.value).toBe('Name that will not save')
  })

  it('discards the draft on cancel', () => {
    const onSave = vi.fn()
    const f = openEditor(onSave)
    fireEvent.change(f.title, { target: { value: 'Abandoned' } })
    fireEvent.click(screen.getByText('common.cancel'))

    expect(onSave).not.toHaveBeenCalled()
    fireEvent.click(screen.getByLabelText(`common.edit ${DOC.title}`))
    expect(screen.getByLabelText('documents.title').value).toBe('Cylon Datasheet')
  })
})

describe('without edit permission', () => {
  it('offers no edit control at all', () => {
    render(<DocumentRow doc={DOC} onSave={null} onRemove={null} busy={false} />)
    expect(screen.queryByLabelText(`common.edit ${DOC.title}`)).toBeNull()
    expect(screen.queryByLabelText(`common.delete ${DOC.title}`)).toBeNull()
  })

  it('still lets a viewer open the document', () => {
    render(<DocumentRow doc={DOC} onSave={null} onRemove={null} busy={false} />)
    expect(screen.getByText('Cylon Datasheet').getAttribute('href')).toBe(DOC.file_url)
  })
})
