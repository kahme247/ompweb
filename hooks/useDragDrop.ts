"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { splitDroppedItems, type FolderAttachmentSource } from "@/lib/attachment-upload";

// Any dragged file or folder can be attached: text inline, images as images,
// everything else as an uploaded path reference.
function isAttachableDragItem(item: DataTransferItem): boolean {
  return item.kind === "file";
}

export function useDragDrop(onDrop: (files: File[], folders: FolderAttachmentSource[]) => void) {
  const [isDragOver, setIsDragOver] = useState(false);
  const counterRef = useRef(0);

  // A drag can end outside the drop target (release over browser chrome, ESC,
  // OS-level cancel) with no balancing dragleave, which would leave the
  // overlay stuck visible until the next drag cycle. Reset on any window-level
  // drop/dragend — handleDrop's own reset stays, this covers the rest.
  useEffect(() => {
    const reset = () => {
      counterRef.current = 0;
      setIsDragOver(false);
    };
    window.addEventListener("drop", reset);
    window.addEventListener("dragend", reset);
    return () => {
      window.removeEventListener("drop", reset);
      window.removeEventListener("dragend", reset);
    };
  }, []);

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    const hasAttachables = Array.from(e.dataTransfer.items).some(isAttachableDragItem);
    if (!hasAttachables) return;
    e.preventDefault();
    counterRef.current += 1;
    setIsDragOver(true);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    const hasAttachables = Array.from(e.dataTransfer.items).some(isAttachableDragItem);
    if (!hasAttachables) return;
    e.preventDefault();
  }, []);

  const handleDragLeave = useCallback(() => {
    counterRef.current -= 1;
    if (counterRef.current <= 0) {
      counterRef.current = 0;
      setIsDragOver(false);
    }
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    counterRef.current = 0;
    setIsDragOver(false);
    // Directory entries are only readable during the drop event itself.
    const { files, folders } = splitDroppedItems(e.dataTransfer);
    onDrop(files, folders);
  }, [onDrop]);

  return { isDragOver, handleDragEnter, handleDragOver, handleDragLeave, handleDrop };
}