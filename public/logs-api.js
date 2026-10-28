export async function readApiResponse(response, fallbackMessage) {
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.toLowerCase().includes('application/json')) {
    throw new Error(
      response.ok
        ? 'The logs API returned an unexpected response. Check the server version and API route.'
        : `The logs API returned HTTP ${response.status} with a non-JSON response. Check the server route and restart the app if it was recently updated.`,
    );
  }

  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error(
      'The logs API returned invalid JSON. Retry after restarting the app.',
    );
  }
  if (!response.ok) {
    throw new Error(
      data?.error || `${fallbackMessage} (HTTP ${response.status}).`,
    );
  }
  return data;
}
