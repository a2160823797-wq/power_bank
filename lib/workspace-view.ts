export type WorkspaceView = 'battery' | 'temperature' | 'upgrade' | 'cell-settings';

const VIEW_KEY = 'powerbank.view';

export function getWorkspaceView(): WorkspaceView {
  try {
    const savedView = localStorage.getItem(VIEW_KEY);
    return savedView === 'upgrade' || savedView === 'temperature' || savedView === 'cell-settings' ? savedView : 'battery';
  } catch {
    return 'battery';
  }
}

export function setWorkspaceView(view: WorkspaceView) {
  try {
    localStorage.setItem(VIEW_KEY, view);
  } catch {}
}
