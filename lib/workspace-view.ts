export type WorkspaceView = 'battery' | 'ntc' | 'upgrade';

const VIEW_KEY = 'powerbank.view';
const listeners = new Set<() => void>();
let cur_view: WorkspaceView | undefined;

export function getWorkspaceView() {
  if (cur_view) return cur_view;
  try {
    const savedView = localStorage.getItem(VIEW_KEY);
    cur_view =
      savedView === 'ntc' || savedView === 'upgrade' ? savedView : 'battery';
  } catch {
    cur_view = 'battery';
  }
  return cur_view;
}

export function setWorkspaceView(view: WorkspaceView) {
  cur_view = view;
  try {
    localStorage.setItem(VIEW_KEY, view);
  } catch {}
  for (const listener of listeners) listener();
}

export function subscribeWorkspaceView(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export const getServerWorkspaceView = (): WorkspaceView | null => null;
