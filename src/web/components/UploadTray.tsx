import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { cn } from '@ui/cn.js';

export interface UploadTrayFile {
  filename: string;
  size: number;
  uploading?: boolean;
  error?: string;
}

export interface UploadTrayProps {
  disabled?: boolean;
  disabledReason?: string;
  onUploaded: (filename: string) => void;
  upload: (file: File) => Promise<{ filename: string; size: number }>;
  maxFileBytes: number;
  maxTotalBytes: number;
  totalBytes: number;
  /**
   * Optional element to wire as a drag-and-drop target. When a file is
   * dropped on this element the tray handles it the same way as the file
   * picker. The element receives a `data-upload-drag-active="true"` attribute
   * while a drag is in progress so the page can style a drop overlay.
   */
  dropZoneRef?: RefObject<HTMLElement | null>;
}

function humanSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function PaperclipIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.49" />
    </svg>
  );
}

export function UploadTray(props: UploadTrayProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleFile = useCallback(
    async (file: File) => {
      if (file.size > props.maxFileBytes) {
        setError(`File too large (max ${humanSize(props.maxFileBytes)})`);
        return;
      }
      if (props.totalBytes + file.size > props.maxTotalBytes) {
        setError('Adding this would exceed the run quota');
        return;
      }
      setError(null);
      try {
        const res = await props.upload(file);
        props.onUploaded(res.filename);
      } catch (e) {
        setError((e as Error).message ?? 'Upload failed');
      }
    },
    [props],
  );

  // Attach drag-and-drop listeners to the opt-in drop zone element.
  useEffect(() => {
    const el = props.dropZoneRef?.current;
    if (!el || props.disabled) return;
    // Track dragenter/leave counter so nested elements don't flicker the overlay.
    let depth = 0;

    const hasFiles = (e: DragEvent) =>
      !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');

    const onDragEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth += 1;
      el.setAttribute('data-upload-drag-active', 'true');
    };
    const onDragOver = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    };
    const onDragLeave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) el.removeAttribute('data-upload-drag-active');
    };
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      // preventDefault must win over the native handlers of any child that
      // accepts drops (e.g. a <textarea> would otherwise insert the file path
      // or, for an image, navigate away from the page). That's why these
      // listeners run in the capture phase — so our handler fires on the
      // ancestor *before* the event reaches the target's native handlers.
      e.preventDefault();
      e.stopPropagation();
      depth = 0;
      el.removeAttribute('data-upload-drag-active');
      const file = e.dataTransfer?.files?.[0];
      if (file) void handleFile(file);
    };

    el.addEventListener('dragenter', onDragEnter, true);
    el.addEventListener('dragover', onDragOver, true);
    el.addEventListener('dragleave', onDragLeave, true);
    el.addEventListener('drop', onDrop, true);
    return () => {
      el.removeEventListener('dragenter', onDragEnter, true);
      el.removeEventListener('dragover', onDragOver, true);
      el.removeEventListener('dragleave', onDragLeave, true);
      el.removeEventListener('drop', onDrop, true);
      el.removeAttribute('data-upload-drag-active');
    };
  }, [props.dropZoneRef, props.disabled, handleFile]);

  const title = props.disabled ? (props.disabledReason ?? '') : 'Attach a file';

  // A <label> wrapping the input is the most robust way to trigger the
  // native file picker across all browsers: clicking the label IS clicking
  // the input via HTML semantics, no JS .click() involved.
  const buttonClass = cn(
    'inline-flex items-center justify-center w-7 h-7 rounded-md text-text-dim transition-colors duration-fast ease-out',
    props.disabled
      ? 'opacity-50 cursor-not-allowed'
      : 'cursor-pointer hover:text-text hover:bg-surface-raised',
  );

  return (
    <div className="flex flex-col gap-2">
      <label
        aria-label="Attach a file"
        title={title}
        aria-disabled={props.disabled}
        className={buttonClass}
      >
        <input
          ref={inputRef}
          data-testid="upload-input"
          type="file"
          disabled={props.disabled}
          onChange={(e) => {
            const file = e.target.files?.[0];
            // Reset so picking the same file twice still fires onChange.
            e.target.value = '';
            if (file) void handleFile(file);
          }}
          className="sr-only"
        />
        <PaperclipIcon />
      </label>
      {error && (
        <div className="text-attn text-sm" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
