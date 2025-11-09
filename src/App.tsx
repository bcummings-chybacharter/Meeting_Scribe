
import React, { useState, useRef, useCallback, useEffect } from 'react';
import { GoogleGenAI, LiveSession, LiveServerMessage, Modality } from "@google/genai";

// AudioWorklet code as a string
const audioWorkletCode = `
class AudioProcessor extends AudioWorkletProcessor {
  process(inputs, outputs, parameters) {
    const input = inputs[0];
    if (input.length > 0) {
      const pcmData = input[0];
      // Convert Float32Array to Int16Array
      const l = pcmData.length;
      const int16 = new Int16Array(l);
      for (let i = 0; i < l; i++) {
          int16[i] = pcmData[i] * 32768;
      }
      this.port.postMessage(int16.buffer, [int16.buffer]);
    }
    return true;
  }
}
registerProcessor('audio-processor', AudioProcessor);
`;

// Define the type for the media blob
type MediaBlob = {
    data: string;
    mimeType: string;
};


// Helper function to encode raw audio data to base64
function encode(bytes: Uint8Array): string {
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// Helper function to format seconds into MM:SS format
function formatTime(seconds: number): string {
    const minutes = Math.floor(seconds / 60).toString().padStart(2, '0');
    const secs = (seconds % 60).toString().padStart(2, '0');
    return `${minutes}:${secs}`;
}

const App: React.FC = () => {
    const [isRecording, setIsRecording] = useState<boolean>(false);
    const [isPaused, setIsPaused] = useState<boolean>(false);
    const [isSummarizing, setIsSummarizing] = useState<boolean>(false);
    const [transcription, setTranscription] = useState<string>('');
    const [summary, setSummary] = useState<string>('');
    const [error, setError] = useState<string>('');
    const [elapsedTime, setElapsedTime] = useState<number>(0);
    const [copiedState, setCopiedState] = useState<'transcription' | 'summary' | null>(null);

    const sessionRef = useRef<Promise<LiveSession> | null>(null);
    const streamRef = useRef<MediaStream | null>(null);
    const audioContextRef = useRef<AudioContext | null>(null);
    const audioWorkletNodeRef = useRef<AudioWorkletNode | null>(null);
    const audioWorkletURLRef = useRef<string | null>(null);
    const fullTranscriptionRef = useRef<string>('');
    const timerIntervalRef = useRef<number | null>(null);
    const lastSpeakerIdRef = useRef<number | null>(null);

    const cleanupRecording = useCallback(() => {
        if (timerIntervalRef.current) {
            clearInterval(timerIntervalRef.current);
            timerIntervalRef.current = null;
        }

        sessionRef.current?.then(session => session.close());
        sessionRef.current = null;

        if (streamRef.current) {
            streamRef.current.getTracks().forEach(track => track.stop());
            streamRef.current = null;
        }

        if (audioWorkletNodeRef.current) {
            audioWorkletNodeRef.current.disconnect();
            audioWorkletNodeRef.current = null;
        }

        if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
            audioContextRef.current.close();
            audioContextRef.current = null;
        }

        if(audioWorkletURLRef.current) {
            URL.revokeObjectURL(audioWorkletURLRef.current);
            audioWorkletURLRef.current = null;
        }

    }, []);


    const startRecording = async () => {
        setError('');
        setTranscription('');
        setSummary('');
        fullTranscriptionRef.current = '';
        lastSpeakerIdRef.current = null;
        setIsPaused(false);
        setIsRecording(true);
        setElapsedTime(0);

        timerIntervalRef.current = window.setInterval(() => {
            setElapsedTime(prev => prev + 1);
        }, 1000);

        try {
            streamRef.current = await navigator.mediaDevices.getUserMedia({ audio: true });

            const ai = new GoogleGenAI({ apiKey: process.env.API_KEY! });
            sessionRef.current = ai.live.connect({
                model: 'gemini-2.5-flash-native-audio-preview-09-2025',
                callbacks: {
                    onopen: () => {
                       console.log('Connection opened');
                    },
                    onmessage: (message: LiveServerMessage) => {
                        if (message.serverContent?.inputTranscription) {
                            const { text, speakerId } = message.serverContent.inputTranscription;
                            if(text) {
                                let newTextSegment = '';
                                if (speakerId && speakerId !== lastSpeakerIdRef.current) {
                                    newTextSegment = `\n\n**Speaker ${speakerId}:** `;
                                    lastSpeakerIdRef.current = speakerId;
                                }
                                newTextSegment += text;
                                fullTranscriptionRef.current += newTextSegment;
                                setTranscription(prev => prev + newTextSegment);
                            }
                        }
                        // Per API guidelines, audio output must be handled when `inputAudioTranscription` is enabled.
                        if (message.serverContent?.modelTurn?.parts[0]?.inlineData?.data) {
                          // This app focuses on transcription and does not process model audio output.
                        }
                    },
                    onerror: (e: ErrorEvent) => {
                        console.error('Connection error', e);
                        setError('An error occurred during the session. Please try again.');
                        stopRecording(true);
                    },
                    onclose: (e: CloseEvent) => {
                        console.log('Connection closed');
                    },
                },
                config: {
                    // Fix: responseModalities must be [Modality.AUDIO] for Live API.
                    responseModalities: [Modality.AUDIO],
                    inputAudioTranscription: {},
                    // Fix: Use speakerDiarizationConfig and maxSpeakerCount.
                    speakerDiarizationConfig: {
                        maxSpeakerCount: 5,
                    },
                },
            });

            // Fix: Cast window to any to support webkitAudioContext for older browsers.
            audioContextRef.current = new ((window as any).AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
            const source = audioContextRef.current.createMediaStreamSource(streamRef.current);

            const audioBlob = new Blob([audioWorkletCode], { type: 'application/javascript' });
            audioWorkletURLRef.current = URL.createObjectURL(audioBlob);
            await audioContextRef.current.audioWorklet.addModule(audioWorkletURLRef.current);
            
            audioWorkletNodeRef.current = new AudioWorkletNode(audioContextRef.current, 'audio-processor');
            
            audioWorkletNodeRef.current.port.onmessage = (event) => {
                const pcmBlob: MediaBlob = {
                    data: encode(new Uint8Array(event.data)),
                    mimeType: 'audio/pcm;rate=16000',
                };
                sessionRef.current?.then((session) => {
                    session.sendRealtimeInput({ media: pcmBlob });
                });
            };
            source.connect(audioWorkletNodeRef.current);
            audioWorkletNodeRef.current.connect(audioContextRef.current.destination);


        } catch (err) {
            console.error(err);
            let errorMessage = 'An unknown error occurred while starting the recording.';
            // Check if the error is a DOMException from getUserMedia
            if (err instanceof DOMException) {
                switch(err.name) {
                    case 'NotAllowedError':
                    case 'PermissionDeniedError': // Firefox name
                        errorMessage = 'Microphone access was denied. To use this feature, please allow microphone access in your browser settings and refresh the page.';
                        break;
                    case 'NotFoundError':
                    case 'DevicesNotFoundError': // Old name
                        errorMessage = 'No microphone was found. Please connect a microphone and try again.';
                        break;
                    case 'NotReadableError':
                    case 'TrackStartError':
                        errorMessage = 'Your microphone may be in use by another application or a hardware error occurred. Please check your microphone and try again.';
                        break;
                    default:
                         errorMessage = 'Could not start recording. Please ensure microphone access is granted and your device is working.';
                }
            } else {
                 errorMessage = 'Could not start recording due to an unexpected error.';
            }

            setError(errorMessage);
            setIsRecording(false);
            cleanupRecording();
        }
    };
    
    const stopRecording = (errorOccurred = false) => {
        setIsRecording(false);
        setIsPaused(false);
        cleanupRecording();
        if (!errorOccurred && fullTranscriptionRef.current.trim().length > 0) {
            summarizeTranscription();
        }
    };

    const handlePauseResume = () => {
        if (!audioContextRef.current) return;

        if (isPaused) {
            audioContextRef.current.resume();
             timerIntervalRef.current = window.setInterval(() => {
                setElapsedTime(prev => prev + 1);
            }, 1000);
        } else {
            audioContextRef.current.suspend();
             if (timerIntervalRef.current) {
                clearInterval(timerIntervalRef.current);
            }
        }
        setIsPaused(!isPaused);
    };

    const summarizeTranscription = async () => {
        if (!fullTranscriptionRef.current) {
            setError("Cannot generate summary from empty transcription.");
            return;
        }
        setIsSummarizing(true);
        setError('');
        setSummary('');

        try {
            const ai = new GoogleGenAI({ apiKey: process.env.API_KEY! });
            const prompt = `Analyze the following meeting transcription and generate a summary in a case note format suitable for a developer's records. The case note should be simple and include the following sections:

**Client & Purpose:** Briefly describe the client's situation and the goal of the meeting.
**Accomplishments:** State what was achieved or decided during the meeting.
**Action Items:** List any clear next steps or tasks.

Use clear, concise language.

Transcription:
${fullTranscriptionRef.current}`;
            const response = await ai.models.generateContent({
              model: 'gemini-2.5-pro',
              contents: prompt,
            });
            setSummary(response.text);
        } catch (err) {
            console.error("Error summarizing:", err);
            setError("Failed to generate summary. Please try again.");
        } finally {
            setIsSummarizing(false);
        }
    };

    const handleCopy = (textToCopy: string, type: 'transcription' | 'summary') => {
        navigator.clipboard.writeText(textToCopy).then(() => {
            setCopiedState(type);
            setTimeout(() => setCopiedState(null), 2000);
        });
    };
    
    useEffect(() => {
        return () => cleanupRecording();
    }, [cleanupRecording]);

    const renderOutputSection = (title: string, content: string, type: 'transcription' | 'summary', isLoading: boolean = false) => {
        const formattedContent = content.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '<br />');

        return (
            <div className="bg-gray-800 rounded-lg p-6 relative">
                <div className="flex justify-between items-center mb-4">
                    <h2 className="text-xl font-semibold text-cyan-400">{title}</h2>
                    {content && !isLoading && (
                        <button
                            onClick={() => handleCopy(content, type)}
                            className="text-gray-400 hover:text-white transition-colors p-2 rounded-full bg-gray-700 hover:bg-gray-600"
                            aria-label={`Copy ${type}`}
                        >
                            {copiedState === type ? (
                                <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                                </svg>
                            ) : (
                                <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                                </svg>
                            )}
                        </button>
                    )}
                </div>
                <div className="bg-gray-900 p-4 rounded-md h-64 overflow-y-auto text-gray-300 relative">
                    {isLoading ? (
                        <div className="flex items-center justify-center h-full">
                            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-cyan-400"></div>
                        </div>
                    ) : (
                        <p className="whitespace-pre-wrap" dangerouslySetInnerHTML={{ __html: formattedContent || `Your ${type} will appear here...` }}></p>
                    )}
                </div>
            </div>
        );
    };

    return (
        <div className="min-h-screen bg-gray-900 text-white font-sans flex flex-col items-center p-4 sm:p-6 md:p-8">
            <div className="w-full max-w-4xl">
                <header className="text-center mb-8">
                    <h1 className="text-4xl sm:text-5xl font-bold text-cyan-400">Meeting Scribe & Summarizer</h1>
                    <p className="text-gray-400 mt-2">Record, transcribe, and summarize your meetings with AI.</p>
                </header>

                <main>
                    <div className="bg-gray-800 rounded-lg p-6 mb-8 flex flex-col sm:flex-row items-center justify-between">
                         <div className="flex items-center space-x-4">
                            <div className={`w-4 h-4 rounded-full ${isRecording ? 'bg-red-500 animate-pulse' : 'bg-gray-600'}`}></div>
                            <span className="text-lg font-mono tabular-nums">{formatTime(elapsedTime)}</span>
                        </div>
                        <div className="flex items-center space-x-2 mt-4 sm:mt-0">
                            {isRecording && (
                                <button
                                    onClick={handlePauseResume}
                                    className="px-4 py-2 bg-yellow-600 hover:bg-yellow-500 rounded-full text-white font-semibold transition-colors flex items-center space-x-2"
                                    aria-label={isPaused ? "Resume recording" : "Pause recording"}
                                >
                                    {isPaused ? 
                                    (<svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM9.555 7.168A1 1 0 008 8v4a1 1 0 001.555.832l3-2a1 1 0 000-1.664l-3-2z" clipRule="evenodd" /></svg>) : 
                                    (<svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zM7 8a1 1 0 012 0v4a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v4a1 1 0 102 0V8a1 1 0 00-1-1z" clipRule="evenodd" /></svg>)
                                    }
                                    <span>{isPaused ? "Resume" : "Pause"}</span>
                                </button>
                            )}
                            <button
                                onClick={isRecording ? () => stopRecording() : startRecording}
                                className={`px-6 py-3 rounded-full text-white font-bold text-lg transition-transform transform hover:scale-105 ${isRecording ? 'bg-red-600 hover:bg-red-500' : 'bg-cyan-600 hover:bg-cyan-500'}`}
                                aria-label={isRecording ? "Stop recording" : "Start recording"}
                            >
                                {isRecording ? 'Stop Recording' : 'Start Recording'}
                            </button>
                        </div>
                    </div>

                    {error && (
                        <div className="bg-red-900 border border-red-700 text-red-200 px-4 py-3 rounded-lg relative mb-6" role="alert">
                            <strong className="font-bold">Error: </strong>
                            <span className="block sm:inline">{error}</span>
                        </div>
                    )}
                    
                    <div className="grid md:grid-cols-2 gap-8">
                       {renderOutputSection("Real-time Transcription", transcription, "transcription")}
                       {renderOutputSection("AI-Generated Summary", summary, "summary", isSummarizing)}
                    </div>
                </main>
                 <footer className="text-center mt-12 text-gray-500 text-sm">
                    <p>Powered by Google Gemini</p>
                </footer>
            </div>
        </div>
    );
};

export default App;
