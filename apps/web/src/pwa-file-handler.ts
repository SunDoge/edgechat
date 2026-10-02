import { SHARE_TARGET_MAX_FILES, stageLocalFiles } from "./share-target";

type FileLaunchHandle = { getFile(): Promise<File> };
type FileLaunchParams = { files: FileLaunchHandle[] };
type FileLaunchQueue = { setConsumer(consumer: (params: FileLaunchParams) => void): void };

export async function stagePwaFileLaunch(handles: readonly FileLaunchHandle[]): Promise<string | null> {
  if (!handles.length) return null;
  // Reading one item beyond the limit is enough to produce a bounded error
  // record without opening an attacker-controlled number of file handles.
  const files = await Promise.all(handles.slice(0, SHARE_TARGET_MAX_FILES + 1).map((handle) => handle.getFile()));
  return (await stageLocalFiles(files)).id;
}

export function registerPwaFileHandler(): void {
  const launchQueue = (window as Window & { launchQueue?: FileLaunchQueue }).launchQueue;
  if (!launchQueue) return;
  launchQueue.setConsumer((params) => {
    void stagePwaFileLaunch(params.files).then((id) => {
      if (!id) return;
      const destination = new URL("/", location.origin);
      destination.searchParams.set("share_target", id);
      location.assign(destination);
    }).catch(() => {
      const destination = new URL("/", location.origin);
      destination.searchParams.set("share_error", "storage");
      location.assign(destination);
    });
  });
}
