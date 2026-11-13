import { describe, expect, it } from 'vitest'
import { contactIdsInPipeline } from './pipeline-filter'

const DEALS = [
  { contact_id: 'ana', pipeline_id: 'vest', stage_id: 'novo' },
  { contact_id: 'bia', pipeline_id: 'vest', stage_id: 'matric' },
  { contact_id: 'caio', pipeline_id: 'pos', stage_id: 'novo-pos' },
  { contact_id: null, pipeline_id: 'vest', stage_id: 'novo' },
  { contact_id: 'ana', pipeline_id: 'pos', stage_id: 'novo-pos' },
]

describe('contactIdsInPipeline', () => {
  it('pipeline sem fase: todos os contatos com negócio nele', () => {
    expect(contactIdsInPipeline(DEALS, { pipelineId: 'vest', stageId: null })).toEqual(new Set(['ana', 'bia']))
  })

  it('pipeline + fase: só quem está naquela fase', () => {
    expect(contactIdsInPipeline(DEALS, { pipelineId: 'vest', stageId: 'matric' })).toEqual(new Set(['bia']))
  })

  it('contato com negócios em dois pipelines aparece nos dois', () => {
    expect(contactIdsInPipeline(DEALS, { pipelineId: 'pos', stageId: null })).toEqual(new Set(['caio', 'ana']))
  })

  it('negócio sem contato (contato apagado) é ignorado', () => {
    expect([...contactIdsInPipeline(DEALS, { pipelineId: 'vest', stageId: 'novo' })]).toEqual(['ana'])
  })
})
