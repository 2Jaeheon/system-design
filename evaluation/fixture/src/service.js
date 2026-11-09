export async function createDiary(text, provider, repository) {
  const diary = await repository.create({ text, state: 'PENDING' });
  try {
    const image = await provider.generate(text);
    await repository.update(diary.id, { state: 'SUCCEEDED', image });
    return { ok: true, id: diary.id };
  } catch {
    await repository.update(diary.id, { state: 'FAILED' });
    return { ok: false };
  }
}
