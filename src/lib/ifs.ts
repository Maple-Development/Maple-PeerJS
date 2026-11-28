import type { SongSource } from '$lib/types';
import { IDB } from '$lib/idb';
import { readonly, writable } from 'svelte/store';
import { v4 as uuidv4 } from 'uuid';

type LinkedSource = Extract<SongSource, { kind: 'linked-folder' }>;
export type LinkedFolder = { id: string; handle: FileSystemDirectoryHandle };

export class IFS {
	private static folders = IDB.keyval<LinkedFolder>('maple-linked-folders');
	private static handles = new Map<string, Promise<FileSystemDirectoryHandle>>();
	private static folderList = writable<LinkedFolder[]>([]);
	public static linkedFolders = readonly(this.folderList);

	public static async loadFolders(): Promise<void> {
		const folders = await this.folders.values();
		for (const { id, handle } of folders) this.handles.set(id, Promise.resolve(handle));
		this.folderList.set(folders);
	}

	public static async needsRelink(handle: FileSystemDirectoryHandle): Promise<boolean> {
		const folder = handle as FileSystemDirectoryHandle & {
			queryPermission?: (options: { mode: 'read' }) => Promise<PermissionState>;
		};
		try {
			const permission = await folder.queryPermission?.({ mode: 'read' });
			if (permission === 'prompt') return false;
			if (permission === 'denied') return true;
			await handle.keys()[Symbol.asyncIterator]().next();
			return false;
		} catch {
			return true;
		}
	}

	private static getFolder(id: string): Promise<FileSystemDirectoryHandle> {
		const cached = this.handles.get(id);
		if (cached) return cached;
		const loading = this.folders.get(id).then((folder) => {
			if (!folder) throw new Error('Link the music folder again to play this track.');
			return folder.handle;
		});
		this.handles.set(id, loading);
		void loading.catch(() => {
			if (this.handles.get(id) === loading) this.handles.delete(id);
		});
		return loading;
	}

	public static async linkFolder(
		handle: FileSystemDirectoryHandle,
		replacement?: { id: string; paths: string[][] }
	): Promise<string> {
		return navigator.locks.request('maple-linked-folders', async () => {
			const replaceId = replacement?.id;
			const folders = await this.folders.values();
			if (replaceId && !folders.some((folder) => folder.id === replaceId)) {
				throw new Error('This source is no longer linked.');
			}
			for (const folder of folders) {
				if (folder.id === replaceId) continue;
				let sameEntry;
				try {
					sameEntry = await handle.isSameEntry(folder.handle);
				} catch (error) {
					if (!(error instanceof DOMException && error.name === 'NotFoundError')) throw error;
				}
				if (sameEntry) throw new Error(`“${handle.name}” is already linked. Choose a different folder.`);
			}
			if (replacement) await this.verifyLocation(handle, replacement.paths);
			const id = replaceId ?? uuidv4();
			await this.folders.set(id, { id, handle });
			this.handles.set(id, Promise.resolve(handle));
			this.folderList.set([...folders.filter((folder) => folder.id !== id), { id, handle }]);
			return id;
		});
	}

	public static async *scanFolder(
		folderId: string,
		directory: FileSystemDirectoryHandle,
		parentPath: string[] = []
	): AsyncGenerator<{ handle: FileSystemFileHandle; source: LinkedSource }> {
		for await (const entry of directory.values()) {
			const path = [...parentPath, entry.name];
			if (entry.kind === 'directory') {
				yield* this.scanFolder(folderId, entry, path);
			} else {
				yield { handle: entry, source: { kind: 'linked-folder', folderId, path } };
			}
		}
	}

	private static async fileAtPath(directory: FileSystemDirectoryHandle, path: string[]) {
		for (const name of path.slice(0, -1)) {
			directory = await directory.getDirectoryHandle(name);
		}
		const fileName = path.at(-1);
		if (!fileName) throw new Error('The linked track is missing its file name.');
		return directory.getFileHandle(fileName);
	}

	private static async verifyLocation(directory: FileSystemDirectoryHandle, paths: string[][]) {
		for (const path of paths) {
			try {
				await this.fileAtPath(directory, path);
				return;
			} catch (error) {
				if (!(error instanceof DOMException && ['NotFoundError', 'TypeMismatchError'].includes(error.name))) throw error;
			}
		}
		if (paths.length) throw new Error('Choose the folder containing your existing tracks in their original subfolders.');
	}

	/**
	 * Make sure Maple may write into a linked folder, asking if needed. Asking only works during
	 * a user gesture, so call this straight from the click, before any slow work.
	 */
	public static async requestWriteAccess(folderId: string): Promise<FileSystemDirectoryHandle> {
		const folder = (await this.getFolder(folderId)) as FileSystemDirectoryHandle & {
			queryPermission?: (options: { mode: 'readwrite' }) => Promise<PermissionState>;
			requestPermission?: (options: { mode: 'readwrite' }) => Promise<PermissionState>;
		};
		const mode = { mode: 'readwrite' } as const;
		if (
			folder.queryPermission &&
			(await folder.queryPermission(mode)) !== 'granted' &&
			(await folder.requestPermission?.(mode)) !== 'granted'
		) {
			throw new Error(`Allow Maple to save files in “${folder.name}”.`);
		}
		return folder;
	}

	/**
	 * Write `file` into the top of a linked folder, under its own name or, if that's taken,
	 * "name (2).ext" and so on. Returns where it went, plus a way to remove it again if the
	 * import fails afterwards.
	 */
	public static async saveFile(
		folderId: string,
		file: File
	): Promise<{ source: LinkedSource; remove: () => Promise<void> }> {
		const folder = await this.requestWriteAccess(folderId);
		const name = await this.freeName(folder, safeFileName(file.name));
		const handle = await folder.getFileHandle(name, { create: true });
		try {
			const writable = await handle.createWritable();
			try {
				await writable.write(file);
				await writable.close();
			} catch (error) {
				await writable.abort().catch(() => {});
				throw error;
			}
		} catch (error) {
			await folder.removeEntry(name).catch(() => {});
			throw error;
		}
		return {
			source: { kind: 'linked-folder', folderId, path: [name] },
			remove: () => folder.removeEntry(name)
		};
	}

	private static async freeName(folder: FileSystemDirectoryHandle, name: string): Promise<string> {
		const dot = name.lastIndexOf('.');
		const stem = dot > 0 ? name.slice(0, dot) : name;
		const ext = dot > 0 ? name.slice(dot) : '';
		for (let n = 1; ; n++) {
			const candidate = n === 1 ? name : `${stem} (${n})${ext}`;
			try {
				await folder.getFileHandle(candidate);
			} catch (error) {
				if (error instanceof DOMException && error.name === 'NotFoundError') return candidate;
				if (error instanceof DOMException && error.name === 'TypeMismatchError') continue;
				throw error;
			}
		}
	}

	public static async openFile(source: LinkedSource): Promise<File> {
		const handle = await this.fileAtPath(await this.getFolder(source.folderId), source.path);
		return handle.getFile();
	}

	public static async clearFolders(): Promise<void> {
		await this.folders.clear();
		this.handles.clear();
		this.folderList.set([]);
	}
}

/** A file name another device sent, made safe to create: no path parts or reserved characters. */
function safeFileName(name: string): string {
	const cleaned = name
		.replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_')
		.replace(/^[\s.]+|[\s.]+$/g, '')
		.slice(-180);
	return cleaned || 'track';
}
