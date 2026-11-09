import { createDiary } from './service.js';

// Example application for evaluation only. No network server is started.
export async function postDiary(body, provider, repository) {
  if (!body.text) return { status: 400, body: { error: 'TEXT_REQUIRED' } };
  const result = await createDiary(body.text, provider, repository);
  return result.ok
    ? { status: 201, body: { diaryId: result.id } }
    : { status: 503, body: { error: 'GENERATION_FAILED' } };
}
