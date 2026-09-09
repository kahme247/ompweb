"use client";

import { useState, useRef, useCallback, useEffect } from "react";

export interface UseDictationOptions {
  onTranscript: (text: string) => void;
  onError?: (error: string) => void;
}

const MAX_RECORDING_MS = 300_000;
const STT_TIMEOUT_MS = 60_000;

function normalizeErrorMessage(error: unknown, fallback: string): string {
  if (typeof error === "string" && error.trim()) return error;
  if (error && typeof error === "object" && "message" in error) {
    const message: unknown = error.message;
    if (typeof message === "string" && message.trim()) return message;
  }
  return fallback;
}

export function useDictation({ onTranscript, onError }: UseDictationOptions) {
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const cancelledRef = useRef(false);
  const isStartingRef = useRef(false);
  const maxTimeoutRef = useRef<number | null>(null);
  const clearMaxTimeout = useCallback(() => {
    if (maxTimeoutRef.current !== null) {
      window.clearTimeout(maxTimeoutRef.current);
      maxTimeoutRef.current = null;
    }
  }, []);

  const cleanup = useCallback(() => {
    clearMaxTimeout();
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      try {
        mediaRecorderRef.current.stop();
      } catch {}
    }
    mediaRecorderRef.current = null;
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    setIsRecording(false);
  }, [clearMaxTimeout]);

  useEffect(() => {
    return () => {
      cancelledRef.current = true;
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }
      cleanup();
    };
  }, [cleanup]);
  const start = useCallback(async () => {
    if (isStartingRef.current || isRecording || isTranscribing) return;
    isStartingRef.current = true;
    cleanup();
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    cancelledRef.current = false;
    if (
      typeof navigator?.mediaDevices?.getUserMedia !== "function" ||
      typeof window === "undefined" ||
      typeof window.MediaRecorder === "undefined"
    ) {
      isStartingRef.current = false;
      onError?.("Microphone not supported in this browser or context");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const recorder = new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;
      const chunks: Blob[] = [];

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      };

      recorder.onstop = async () => {
        if (cancelledRef.current) return;
        clearMaxTimeout();
        if (chunks.length === 0) return;
        setIsTranscribing(true);
        const abortController = new AbortController();
        abortControllerRef.current = abortController;
        const timeoutId = window.setTimeout(() => {
          abortController.abort(new DOMException("Transcription timed out", "TimeoutError"));
        }, STT_TIMEOUT_MS);

        try {
          const mimeType = recorder.mimeType || "audio/webm";
          const blob = new Blob(chunks, { type: mimeType });
          const ext = mimeType.includes("mp4") ? "audio.mp4" : mimeType.includes("ogg") ? "audio.ogg" : "audio.webm";
          const body = new FormData();
          body.append("file", blob, ext);

          const res = await fetch("/api/stt", {
            method: "POST",
            body,
            signal: abortController.signal,
          });
          if (cancelledRef.current) return;
          const data = await res.json();
          if (cancelledRef.current) return;
          if (!res.ok) {
            onError?.(normalizeErrorMessage(data?.error, "Transcription failed"));
            return;
          }
          if (typeof data.text === "string" && data.text.trim()) {
            if (!cancelledRef.current) {
              onTranscript(data.text.trim());
            }
          } else {
            if (!cancelledRef.current) {
              onError?.("No speech detected");
            }
          }
        } catch (err) {
          if (cancelledRef.current) return;
          if (err instanceof DOMException && err.name === "AbortError") return;
          onError?.(
            err instanceof Error
              ? err.message
              : normalizeErrorMessage(err, "Transcription failed"),
          );
        } finally {
          window.clearTimeout(timeoutId);
          if (abortControllerRef.current === abortController) {
            abortControllerRef.current = null;
          }
          setIsTranscribing(false);
        }
      };

      recorder.start();
      setIsRecording(true);
      maxTimeoutRef.current = window.setTimeout(() => {
        if (mediaRecorderRef.current?.state === "recording") {
          try {
            mediaRecorderRef.current.stop();
          } catch {}
        }
        if (streamRef.current) {
          streamRef.current.getTracks().forEach((track) => track.stop());
          streamRef.current = null;
        }
        setIsRecording(false);
      }, MAX_RECORDING_MS);
    } catch (err) {
      cleanup();
      onError?.(err instanceof Error ? err.message : "Microphone access denied");
    } finally {
      isStartingRef.current = false;
    }
  }, [isRecording, isTranscribing, cleanup, clearMaxTimeout, onTranscript, onError]);

  const stop = useCallback(() => {
    if (!isRecording) return;
    clearMaxTimeout();
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      try {
        mediaRecorderRef.current.stop();
      } catch {}
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    setIsRecording(false);
  }, [isRecording, clearMaxTimeout]);

  const cancel = useCallback(() => {
    cancelledRef.current = true;
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    setIsTranscribing(false);
    cleanup();
  }, [cleanup]);

  const toggle = useCallback(() => {
    if (isRecording) stop();
    else void start();
  }, [isRecording, start, stop]);

  return { isRecording, isTranscribing, start, stop, cancel, toggle };
}
