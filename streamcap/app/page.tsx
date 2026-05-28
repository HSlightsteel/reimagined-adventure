'use client';

import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  Play, Square, Circle, Cloud, CloudOff,
  Video, Mic, MicOff, Settings, ListVideo,
  Search, CheckCircle2, Loader2, Camera, CloudCog,
  History, SignalHigh, PlayCircle, X, Maximize2,
  Bookmark, Activity, Radio, Plus, MoreVertical, Eye,
  Calendar, Users, ChevronDown, ChevronUp, Clock, Film, ListFilter,
  LayoutGrid, List, Trash2
} from 'lucide-react';

// --- TYPES ---

type Tab = 'record' | 'active' | 'watchlist' | 'library' | 'settings';

interface RecordingPart {
  id: string;
  duration: number; // in seconds
  thumbnail?: string;
}

interface Recording {
  id: string;
  title: string;
  duration: number; // in seconds
  timestamp: Date;
  synced: boolean;
  thumbnail: string;
  creatorName?: string;
  creatorAvatar?: string;
  platform?: string;
  driveFileId?: string;
  messageId?: number;
  filename: string;
  sizeMB: number;
  parts?: RecordingPart[];
}

// --- UTILS ---

const formatDuration = (seconds: number) => {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
};

const formatSize = (mb: number) => {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${mb} MB`;
};

const loadMpegtsScript = (): Promise<any> => {
  return new Promise((resolve) => {
    if ((window as any).mpegts) {
      resolve((window as any).mpegts);
      return;
    }
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/mpegts.js@1.7.3/dist/mpegts.min.js';
    script.onload = () => resolve((window as any).mpegts);
    document.head.appendChild(script);
  });
};

// --- REAL FLV LIVE STREAM PLAYER ---

function LivePlayer({ username }: { username: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const playerRef = useRef<any>(null);

  useEffect(() => {
    let active = true;
    const init = async () => {
      const mpegts = await loadMpegtsScript();
      if (!active || !videoRef.current) return;

      if (mpegts.getFeatureList().mseLivePlayback) {
        try {
          const player = mpegts.createPlayer({
            type: 'flv',
            isLive: true,
            url: `/api/stream/${username}`
          });
          player.attachMediaElement(videoRef.current);
          player.load();
          player.play().catch((err: any) => console.log('Autoplay blocked:', err));
          playerRef.current = player;
        } catch (err) {
          console.error('Failed to init live player', err);
        }
      }
    };

    init();

    return () => {
      active = false;
      if (playerRef.current) {
        playerRef.current.destroy();
        playerRef.current = null;
      }
    };
  }, [username]);

  return <video ref={videoRef} className="w-full h-full object-contain" controls autoPlay />;
}

// --- MAIN APP COMPONENT ---

export default function StreamCapApp() {
  const [activeTab, setActiveTab] = useState<Tab>('record');
  const [cloudStatus, setCloudStatus] = useState<'connected' | 'syncing' | 'offline'>('connected');
  const [watchlist, setWatchlist] = useState<any[]>([]);
  const [status, setStatus] = useState<any>({ activeRecordings: [], activeUploads: [] });
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const triggerToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 2500);
  };

  const fetchStatusAndWatchlist = async () => {
    try {
      const [statusRes, liveRes] = await Promise.all([
        fetch('/api/status').then(r => r.json()),
        fetch('/api/live').then(r => r.json())
      ]);
      setStatus(statusRes);
      
      const liveUsers = liveRes.users || [];
      const list = liveUsers.map((u: any) => ({
        id: `w_tk_${u.username}`,
        username: u.username,
        name: u.username,
        platform: 'TikTok',
        status: u.isLive ? 'Live' : 'Offline',
        avatar: `/api/avatar/${u.username}`,
        lastSeen: u.isLive ? 'Now' : 'Never',
        autoRecord: true,
        isRecording: u.isRecording
      }));
      setWatchlist(list);
    } catch (err) {
      console.error('Failed to sync statuses', err);
    }
  };

  useEffect(() => {
    fetchStatusAndWatchlist();
    const interval = setInterval(fetchStatusAndWatchlist, 15000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="flex flex-col-reverse md:flex-row h-screen w-full bg-[#050505] overflow-hidden text-white font-sans">
      <SideNav activeTab={activeTab} setActiveTab={setActiveTab} />
      
      <main className="flex-1 flex flex-col h-full overflow-hidden relative">
        <TopBar cloudStatus={cloudStatus} />
        
        <div className="flex-1 overflow-y-auto no-scrollbar relative">
          <AnimatePresence mode="wait">
            {activeTab === 'record' && (
              <RecordView 
                setCloudStatus={setCloudStatus} 
                watchlist={watchlist} 
                setWatchlist={setWatchlist}
                refetchWatchlist={fetchStatusAndWatchlist}
                triggerToast={triggerToast}
              />
            )}
            {activeTab === 'active' && <ActiveView status={status} />}
            {activeTab === 'watchlist' && (
              <WatchlistView 
                watchlist={watchlist} 
                setWatchlist={setWatchlist} 
                refetchWatchlist={fetchStatusAndWatchlist}
                triggerToast={triggerToast}
              />
            )}
            {activeTab === 'library' && (
              <LibraryView 
                setCloudStatus={setCloudStatus}
                triggerToast={triggerToast}
              />
            )}
            {activeTab === 'settings' && <SettingsView />}
          </AnimatePresence>
        </div>
      </main>

      {/* Toast Alert */}
      <AnimatePresence>
        {toastMessage && (
          <motion.div 
            initial={{ opacity: 0, y: 50 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 50 }}
            className="fixed bottom-6 right-6 z-50 bg-zinc-900 border border-zinc-800 text-white font-bold text-xs uppercase tracking-wider px-5 py-3 rounded-2xl shadow-xl flex items-center gap-2"
          >
            <Activity className="w-4 h-4 text-blue-500 animate-pulse" />
            {toastMessage}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// --- NAVIGATION ---

const RecordIcon = ({ active }: { active: boolean }) => (
  <svg viewBox="0 0 24 24" className="w-6 h-6 z-10 relative transition-transform duration-300 group-hover:scale-110" fill="none" xmlns="http://www.w3.org/2000/svg">
    <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="1.5" className={active ? "text-red-500/40" : "text-zinc-700"} />
    <circle cx="12" cy="12" r="7" stroke="currentColor" strokeWidth="1" strokeDasharray="3 2" className={active ? "text-red-400/80" : "text-zinc-650"} />
    <circle cx="12" cy="12" r="3.5" className={active ? "fill-red-500 stroke-red-400 stroke-[1.5] animate-pulse" : "fill-zinc-650 stroke-zinc-500"} />
    <path d="M5 8V5H8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className={active ? "text-red-500" : "text-zinc-700"} />
    <path d="M19 8V5H16" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className={active ? "text-red-500" : "text-zinc-700"} />
    <path d="M5 16V19H8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className={active ? "text-red-500" : "text-zinc-700"} />
    <path d="M19 16V19H16" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className={active ? "text-red-500" : "text-zinc-700"} />
  </svg>
);

const ActiveIcon = ({ active }: { active: boolean }) => (
  <svg viewBox="0 0 24 24" className="w-6 h-6 z-10 relative transition-transform duration-300 group-hover:scale-110" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M12 21V12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className={active ? "text-emerald-500" : "text-zinc-650"} />
    <circle cx="12" cy="10" r="2" stroke="currentColor" className={active ? "fill-emerald-500/20 stroke-emerald-400" : "fill-zinc-750 stroke-zinc-600"} />
    <path d="M9 7C7.5 8.5 7.5 11.5 9 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className={active ? "text-emerald-400/80" : "text-zinc-705"} />
    <path d="M15 7C16.5 8.5 16.5 11.5 15 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className={active ? "text-emerald-400/80" : "text-zinc-705"} />
  </svg>
);

const WatchlistIcon = ({ active }: { active: boolean }) => (
  <svg viewBox="0 0 24 24" className="w-6 h-6 z-10 relative transition-transform duration-300 group-hover:scale-110" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M12 2L20 6.5V15.5L12 21L4 15.5V6.5L12 2Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" className={active ? "text-purple-500" : "text-zinc-700"} />
    <path d="M12 6.5L13.5 10H17L14.2 12.2L15.3 15.8L12 13.5L8.7 15.8L9.8 12.2L7 10H10.5L12 6.5Z" stroke="currentColor" strokeWidth="1" className={active ? "fill-purple-500/20 stroke-purple-400" : "fill-zinc-850 stroke-zinc-600"} />
  </svg>
);

const LibraryIcon = ({ active }: { active: boolean }) => (
  <svg viewBox="0 0 24 24" className="w-6 h-6 z-10 relative transition-transform duration-300 group-hover:scale-110" fill="none" xmlns="http://www.w3.org/2000/svg">
    <circle cx="8" cy="12" r="5" stroke="currentColor" strokeWidth="1.5" className={active ? "text-blue-500" : "text-zinc-700"} />
    <circle cx="8" cy="12" r="2" stroke="currentColor" strokeWidth="1" className={active ? "text-blue-400" : "text-zinc-800"} />
    <circle cx="16" cy="12" r="5" stroke="currentColor" strokeWidth="1.5" className={active ? "text-blue-500" : "text-zinc-700"} />
    <circle cx="16" cy="12" r="2" stroke="currentColor" strokeWidth="1" className={active ? "text-blue-400" : "text-zinc-800"} />
    <path d="M8 7H16M8 17H16" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className={active ? "text-cyan-400" : "text-zinc-650"} />
  </svg>
);

const SettingsIcon = ({ active }: { active: boolean }) => (
  <svg viewBox="0 0 24 24" className="w-6 h-6 z-10 relative transition-transform duration-300 group-hover:scale-110" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect x="4" y="4" width="16" height="16" rx="3" stroke="currentColor" strokeWidth="1.5" className={active ? "text-amber-500" : "text-zinc-700"} />
    <rect x="9" y="9" width="6" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.5" className={active ? "text-amber-400 fill-amber-500/10" : "text-zinc-800"} />
    <path d="M12 4V9M12 15V20M4 12H9M15 12H20" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className={active ? "text-amber-400" : "text-zinc-750"} />
  </svg>
);

function SideNav({ activeTab, setActiveTab }: { activeTab: Tab, setActiveTab: (t: Tab) => void }) {
  const navItems = [
    { id: 'record', icon: RecordIcon, label: 'Record' },
    { id: 'active', icon: ActiveIcon, label: 'Active' },
    { id: 'watchlist', icon: WatchlistIcon, label: 'Watchlist' },
    { id: 'library', icon: LibraryIcon, label: 'Library' },
    { id: 'settings', icon: SettingsIcon, label: 'Settings' },
  ] as const;

  const themeColors = {
    record: { text: 'text-red-500', pill: 'bg-red-500/10' },
    active: { text: 'text-emerald-500', pill: 'bg-emerald-500/10' },
    watchlist: { text: 'text-purple-500', pill: 'bg-purple-500/10' },
    library: { text: 'text-blue-500', pill: 'bg-blue-500/10' },
    settings: { text: 'text-amber-500', pill: 'bg-amber-500/10' },
  } as const;

  return (
    <nav className="m-4 md:m-6 mt-0 md:mt-6 w-[calc(100%-2rem)] md:w-24 md:h-[calc(100%-3rem)] bg-zinc-900 border border-zinc-800 flex md:flex-col items-center justify-around md:justify-center md:gap-7 px-2 py-3 md:py-8 z-50 rounded-2xl md:rounded-3xl self-center shrink-0 overflow-x-auto no-scrollbar">
      {navItems.map((item) => {
        const isActive = activeTab === item.id;
        const Icon = item.icon;
        const colors = themeColors[item.id];
        return (
          <button
            key={item.id}
            onClick={() => setActiveTab(item.id)}
            className={`flex flex-col items-center gap-1.5 transition-colors relative group w-16 md:w-full ${
              isActive ? colors.text : 'text-zinc-500 hover:text-zinc-300'
            }`}
          >
            <div className="relative">
              {isActive && (
                <motion.div
                  layoutId="nav-pill"
                  className={`absolute inset-[-8px] rounded-xl ${colors.pill}`}
                  transition={{ type: 'spring', stiffness: 300, damping: 30 }}
                />
              )}
              <Icon active={isActive} />
            </div>
            <span className="text-[10px] font-bold tracking-wide">{item.label}</span>
          </button>
        );
      })}
    </nav>
  );
}

function TopBar({ cloudStatus }: { cloudStatus: 'connected' | 'syncing' | 'offline' }) {
  return (
    <header className="h-16 mt-2 md:mt-6 flex items-center justify-between px-4 lg:px-6 bg-transparent z-10 shrink-0">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 bg-red-600 rounded-lg flex items-center justify-center">
          <div className="w-4 h-4 bg-white rounded-full"></div>
        </div>
        <div className="hidden sm:flex flex-col">
          <span className="font-bold tracking-tight text-xl leading-tight">StreamVault</span>
          <span className="text-[10px] text-zinc-500 font-mono uppercase tracking-widest leading-tight">Miniapp v2.4.0</span>
        </div>
      </div>

      <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-zinc-900 border border-zinc-800 text-xs font-medium">
        {cloudStatus === 'connected' && (
          <>
            <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse" />
            <span className="text-zinc-400">Cloud Sync Active</span>
          </>
        )}
        {cloudStatus === 'syncing' && (
          <>
            <Loader2 className="w-3.5 h-3.5 text-blue-400 animate-spin" />
            <span className="text-blue-400">Syncing...</span>
          </>
        )}
        {cloudStatus === 'offline' && (
          <>
            <CloudOff className="w-3.5 h-3.5 text-red-500" />
            <span className="text-zinc-400">Offline</span>
          </>
        )}
      </div>
    </header>
  );
}

// --- RECORD VIEW ---

function RecordView({ setCloudStatus, watchlist, setWatchlist, refetchWatchlist, triggerToast }: { 
  setCloudStatus: (s: 'connected' | 'syncing') => void, 
  watchlist: any[], 
  setWatchlist: (v: any[]) => void, 
  refetchWatchlist: () => any,
  triggerToast: (msg: string) => void
}) {
  const [recordingState, setRecordingState] = useState<'idle' | 'starting' | 'recording' | 'saving'>('idle');
  const [streamUrl, setStreamUrl] = useState('');
  const [seconds, setSeconds] = useState(0);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [searchError, setSearchError] = useState<{ error?: string, message: string } | null>(null);
  const [activeRecordingCreator, setActiveRecordingCreator] = useState<any | null>(null);

  const handleInputChange = (val: string) => {
    setStreamUrl(val);
    if (!val || val.trim().length < 2 || val.startsWith('http')) {
      setSearchResults([]);
      setSearchError(null);
    }
  };

  useEffect(() => {
    if (!streamUrl || streamUrl.trim().length < 2 || streamUrl.startsWith('http')) {
      return;
    }

    const timer = setTimeout(async () => {
      setSearchLoading(true);
      setSearchError(null);
      try {
        const res = await fetch('/api/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: streamUrl.trim() })
        });
        const data = await res.json();
        
        if (data.exists) {
          setSearchResults([{
            username: data.username,
            display_name: data.username,
            avatar_url: `/api/avatar/${data.username}`,
            follower_count: 85200,
            is_live: data.isLive,
            platform: "TikTok",
            bio: "TikTok creator resolved live via ApiServer."
          }]);
        } else {
          setSearchResults([]);
          setSearchError({ message: 'Creator not found' });
        }
      } catch (err: any) {
        setSearchError({ message: 'Failed to search' });
      } finally {
        setSearchLoading(false);
      }
    }, 600);

    return () => clearTimeout(timer);
  }, [streamUrl]);

  const handleApiAdd = async (user: any) => {
    try {
      await fetch('/api/watchlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: user.username })
      });
      triggerToast(`Added @${user.username} to watchlist`);
      refetchWatchlist();
    } catch {
      triggerToast(`Failed to add @${user.username}`);
    }
  };

  useEffect(() => {
    let interval: NodeJS.Timeout;
    if (recordingState === 'recording') {
      interval = setInterval(() => setSeconds(s => s + 1), 1000);
    }
    return () => {
      if (interval) clearInterval(interval);
    };
  }, [recordingState]);

  const triggerRecording = async (creator: any) => {
    setRecordingState('starting');
    setActiveRecordingCreator(creator);
    try {
      await fetch(`/api/rec/${creator.username}`, { method: 'POST' });
      setSeconds(0);
      setRecordingState('recording');
      triggerToast(`🔴 Started recording @${creator.username}`);
      refetchWatchlist();
    } catch (err) {
      setRecordingState('idle');
      triggerToast(`❌ Failed to start recording`);
    }
  };

  const handleStopRecording = async () => {
    if (!activeRecordingCreator) return;
    setRecordingState('saving');
    try {
      await fetch(`/api/stop/${activeRecordingCreator.username}`, { method: 'POST' });
      triggerToast(`⏹ Stopped recording @${activeRecordingCreator.username}`);
      refetchWatchlist();
      setRecordingState('idle');
      setActiveRecordingCreator(null);
      setStreamUrl('');
    } catch (err) {
      triggerToast(`❌ Failed to stop recording`);
    }
  };

  const PLATFORMS = [
    { name: 'TikTok', icon: <Video className="w-6 h-6 text-pink-400" />, schema: 'highland.fashion7', bg: 'hover:border-pink-500/35 hover:bg-pink-500/5' },
    { name: 'Twitch', icon: <Radio className="w-6 h-6 text-purple-400" />, schema: 'twitch_suggest', bg: 'hover:border-purple-500/35 hover:bg-purple-500/5' }
  ];

  return (
    <motion.div 
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -10 }}
      className="flex flex-col h-full w-full max-w-4xl mx-auto p-4 md:p-6 font-sans"
    >
      {recordingState === 'idle' ? (
        <div className="flex flex-col w-full pb-20">
          
          <div className="w-full mb-8 bg-zinc-900 border border-zinc-800 rounded-3xl p-6 shadow-xl relative overflow-hidden">
            <div className="absolute top-0 right-0 w-32 h-32 bg-blue-500/5 rounded-full blur-3xl" />
            <label className="block text-xs font-bold text-zinc-400 mb-4 uppercase tracking-wider ml-1">
              Live Stream Capture Engine
            </label>
            <div className="flex items-center bg-zinc-950 border border-zinc-800 hover:border-zinc-700 focus-within:border-blue-500 transition-all rounded-2xl p-2 h-16 shadow-inner">
              <SignalHigh className="w-5 h-5 text-zinc-500 ml-3 shrink-0" />
              <input 
                type="text"
                placeholder="Enter TikTok username to resolve live..."
                value={streamUrl}
                onChange={(e) => handleInputChange(e.target.value)}
                className="flex-1 bg-transparent border-none outline-none px-4 text-white placeholder:text-zinc-650 text-sm md:text-base h-full font-medium"
              />
              {streamUrl && (
                <button onClick={() => { setStreamUrl(''); setSearchResults([]); }} className="p-1 px-3 text-xs text-zinc-500 hover:text-white font-semibold transition-colors">
                  Clear
                </button>
              )}
            </div>
          </div>

          <div className="flex-1">
            <AnimatePresence mode="wait">
              {streamUrl ? (
                <motion.div key="results" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="flex flex-col gap-4">
                  <div className="flex items-center gap-2 px-1">
                    <Radio className="w-4 h-4 text-blue-400" />
                    <span className="text-xs uppercase font-bold tracking-widest text-zinc-400">Creators matching &quot;{streamUrl}&quot;</span>
                  </div>

                  {searchLoading ? (
                    <div className="flex flex-col items-center justify-center py-16 gap-3 bg-zinc-900 border border-zinc-800 rounded-3xl">
                      <Loader2 className="w-8 h-8 text-blue-500 animate-spin" />
                      <span className="text-xs text-zinc-500 font-medium uppercase tracking-wider">Searching stream networks...</span>
                    </div>
                  ) : searchError ? (
                    <div className="bg-red-500/5 border border-red-500/10 rounded-2xl p-6 text-center text-zinc-400">
                      <p className="text-xs text-red-400 font-semibold mb-2">{searchError.message}</p>
                    </div>
                  ) : searchResults.length > 0 ? (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      {searchResults.map((user: any) => {
                        const isAdded = watchlist.some(w => w.username === user.username);
                        return (
                          <div key={user.username} className="bg-zinc-900 border border-zinc-800/80 rounded-3xl p-5 hover:border-zinc-700 transition-all duration-300 flex flex-col justify-between relative overflow-hidden group shadow-lg">
                            {user.is_live && (
                              <div className="absolute top-4 right-4 bg-red-650/15 border border-red-500/30 px-2 py-0.5 rounded-full flex items-center gap-1">
                                <span className="w-1.5 h-1.5 bg-red-500 rounded-full animate-pulse" />
                                <span className="text-[8px] uppercase font-bold text-red-400 tracking-widest">Live</span>
                              </div>
                            )}

                            <div className="flex gap-4">
                              <div className="relative">
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <img alt={user.username} src={user.avatar_url} className={`w-14 h-14 rounded-2xl object-cover border bg-zinc-950 ${user.is_live ? 'border-red-500' : 'border-zinc-700'}`} />
                              </div>
                              <div className="flex-1 min-w-0">
                                <h4 className="font-extrabold text-sm text-white truncate pr-14">@{user.username}</h4>
                                <p className="text-xs text-zinc-500">TikTok</p>
                              </div>
                            </div>

                            <div className="flex items-center gap-2 mt-5 pt-4 border-t border-zinc-800/60">
                              <button 
                                onClick={() => handleApiAdd(user)}
                                disabled={isAdded}
                                className={`flex-1 py-2 rounded-xl text-[10px] font-bold uppercase tracking-widest transition-all text-center flex items-center justify-center gap-1.5 ${
                                  isAdded ? 'bg-zinc-950 text-emerald-500 border border-emerald-500/20' : 'bg-zinc-950 text-zinc-400 border border-zinc-800 hover:text-white'
                                }`}
                              >
                                {isAdded ? <CheckCircle2 className="w-3.5 h-3.5" /> : <Bookmark className="w-3.5 h-3.5" />}
                                {isAdded ? 'Watchlisted' : 'To Watchlist'}
                              </button>
                              
                              <button 
                                onClick={() => triggerRecording(user)}
                                className="flex-1 py-2 bg-red-600/10 hover:bg-red-600 border border-red-600/30 text-red-500 hover:text-white rounded-xl text-[10px] font-bold uppercase tracking-widest transition-all text-center flex items-center justify-center gap-1.5"
                              >
                                <Video className="w-3.5 h-3.5 shrink-0" />
                                Record Live
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  ) : null}
                </motion.div>
              ) : (
                <motion.div key="default-hub" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="space-y-8">
                  <div>
                    <h3 className="text-[10px] uppercase font-bold text-zinc-550 tracking-widest mb-4 pl-1">Quick Stream Captures</h3>
                    <div className="grid grid-cols-2 gap-3">
                      {PLATFORMS.map((platform) => (
                        <div key={platform.name} onClick={() => setStreamUrl(platform.schema)} className={`bg-zinc-900 border border-zinc-800/60 rounded-2xl p-4 flex flex-col items-center justify-center gap-2 cursor-pointer transition-all ${platform.bg}`}>
                          {platform.icon}
                          <span className="text-xs font-bold text-zinc-300">{platform.name}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
      ) : (
        <motion.div key="console" initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }} className="flex flex-col items-center justify-center h-full max-w-2xl mx-auto w-full py-6 pr-1 pl-1">
          <div className="w-full bg-zinc-900 border border-red-500/20 rounded-3xl p-6 md:p-8 flex flex-col shadow-[0_0_35px_rgba(220,38,38,0.15)] relative overflow-hidden">
            <div className="absolute top-0 left-0 right-0 h-1.5 bg-gradient-to-r from-red-600 via-rose-500 to-red-600" />
            <div className="flex justify-between items-start mb-6">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-red-600/10 text-red-500 border border-red-500/20 flex items-center justify-center shrink-0">
                  <Video className="w-5 h-5 animate-pulse" />
                </div>
                <div>
                  <h3 className="font-extrabold text-sm text-white flex items-center gap-1.5">
                    StreamIngest Core
                    <span className="px-1.5 py-0.5 rounded bg-red-600 text-[8px] uppercase tracking-widest text-white animate-pulse">Live</span>
                  </h3>
                </div>
              </div>
            </div>

            <div className="relative aspect-video w-full bg-black/85 rounded-2xl overflow-hidden mb-6 flex flex-col items-center justify-center border border-zinc-800">
              <div className="absolute inset-0 bg-zinc-950/40 flex flex-col items-center justify-center p-4">
                <div className="flex items-center gap-1.5 h-16 w-36 justify-center">
                  {[1, 2, 3, 4, 5].map((bar, i) => (
                    <motion.div 
                      key={i}
                      animate={{ height: ['15%', '85%', '15%'] }}
                      transition={{ duration: 1 + i * 0.15, repeat: Infinity }}
                      className="w-1.5 bg-red-600 rounded-full"
                    />
                  ))}
                </div>
                <span className="text-[9px] font-mono text-zinc-400 tracking-widest mt-4 uppercase">
                  ACTIVE INGEST: @{activeRecordingCreator?.username}
                </span>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3 bg-zinc-950 border border-zinc-800/80 rounded-2xl p-4 mb-8">
              <div className="flex flex-col">
                <span className="text-[9px] uppercase font-bold text-zinc-550">Elapsed</span>
                <span className="text-lg font-mono font-bold text-white mt-0.5">{formatDuration(seconds)}</span>
              </div>
              <div className="flex flex-col">
                <span className="text-[9px] uppercase font-bold text-zinc-550">Ingesting</span>
                <span className="text-sm font-bold text-white mt-1">1080p capture</span>
              </div>
            </div>

            <button onClick={handleStopRecording} className="w-full py-4 bg-red-600 hover:bg-red-500 text-white font-bold text-sm uppercase tracking-wider rounded-2xl transition-all shadow-lg flex items-center justify-center gap-2">
              <Square className="w-4 h-4 fill-current" /> Stop &amp; Save Ingest
            </button>
          </div>
        </motion.div>
      )}
    </motion.div>
  );
}

// --- ACTIVE VIEW (RECORDS AND PLAYS LIVE STREAMS) ---

function ActiveView({ status }: { status: any }) {
  const [playingId, setPlayingId] = useState<string | null>(null);

  const activeStreams = (status.activeRecordings || []).map((r: any) => ({
    id: r.username,
    title: `@${r.username} Live Broadcast`,
    duration: r.durationSeconds || 0,
    platform: 'TikTok',
    thumbnail: `/api/avatar/${r.username}`
  }));

  return (
    <motion.div 
      initial={{ opacity: 0, x: 20 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -20 }}
      className="flex flex-col h-full w-full max-w-4xl mx-auto p-4 md:p-6 font-sans"
    >
      <div className="flex items-center gap-4 mb-6">
        <h2 className="text-2xl font-bold tracking-tight text-white">Live Ingest Monitor</h2>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pb-20 md:pb-0">
        {activeStreams.map((item: any) => (
          <div 
            key={item.id}
            onClick={() => setPlayingId(item.id)}
            className="group relative bg-zinc-900 border border-red-600/30 hover:border-red-500/50 rounded-3xl overflow-hidden transition-all duration-300 cursor-pointer flex flex-col shadow-lg"
          >
            <div className="aspect-video w-full bg-zinc-950 relative overflow-hidden flex-shrink-0">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={item.thumbnail} alt={item.title} className="w-full h-full object-cover opacity-80 group-hover:scale-105 transition-all duration-500" />
              <div className="absolute inset-0 bg-gradient-to-t from-black/80 to-transparent" />
              <div className="absolute top-3 left-3 flex gap-2">
                <div className="bg-red-600 px-2.5 py-1 rounded flex items-center gap-1.5 border border-red-500">
                  <div className="w-1.5 h-1.5 bg-white rounded-full animate-pulse" />
                  <span className="text-[10px] font-bold text-white uppercase tracking-widest">INGESTING</span>
                </div>
              </div>
              <div className="absolute top-3 right-3 bg-black/60 border border-zinc-800 px-2 py-1 rounded text-[10px] font-mono text-white">
                {formatDuration(item.duration)}
              </div>
            </div>
            <div className="p-5 flex-1 flex flex-col justify-between bg-zinc-900/50">
              <h3 className="font-bold text-sm text-white truncate group-hover:text-red-400 transition-colors">{item.title}</h3>
            </div>
          </div>
        ))}
        {activeStreams.length === 0 && (
          <div className="py-20 flex flex-col items-center justify-center text-zinc-500 w-full col-span-2">
            <CloudOff className="w-12 h-12 mb-4 opacity-30" />
            <p className="text-sm font-semibold">No active stream ingestion happening</p>
          </div>
        )}
      </div>

      <AnimatePresence>
        {playingId && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-50 bg-[#050505]/95 backdrop-blur-lg flex items-center justify-center p-4">
            <div className="w-full max-w-5xl rounded-3xl overflow-hidden bg-zinc-900 border border-red-600/30 flex flex-col">
              <div className="px-6 py-4 flex flex-row items-center justify-between border-b border-zinc-855/60 shrink-0">
                <h3 className="font-bold text-white flex items-center gap-2">
                  @{playingId} Live Stream
                  <span className="px-1.5 py-0.5 rounded bg-red-600 text-[8px] uppercase tracking-widest text-white">Live</span>
                </h3>
                <button onClick={() => setPlayingId(null)} className="w-10 h-10 rounded-full bg-zinc-805 hover:bg-zinc-700 flex items-center justify-center shadow-lg">
                  <X className="w-5 h-5 text-zinc-400" />
                </button>
              </div>
              <div className="relative aspect-video bg-black w-full flex items-center justify-center">
                <LivePlayer username={playingId} />
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

// --- WATCHLIST VIEW (MANAGES WATCHED STREAMERS) ---

function WatchlistView({ watchlist, setWatchlist, refetchWatchlist, triggerToast }: {
  watchlist: any[],
  setWatchlist: (v: any[]) => void,
  refetchWatchlist: () => any,
  triggerToast: (msg: string) => void
}) {
  const [isAdding, setIsAdding] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [searchError, setSearchError] = useState<{ error?: string, message: string } | null>(null);

  const handleSearchChange = (val: string) => {
    setSearchQuery(val);
    if (!val || val.trim().length < 2) {
      setSearchResults([]);
      setSearchError(null);
    }
  };

  useEffect(() => {
    if (!searchQuery || searchQuery.trim().length < 2) {
      return;
    }

    const timer = setTimeout(async () => {
      setSearchLoading(true);
      setSearchError(null);
      try {
        const res = await fetch('/api/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: searchQuery.trim() })
        });
        const data = await res.json();
        
        if (data.exists) {
          setSearchResults([{
            username: data.username,
            display_name: data.username,
            avatar_url: `/api/avatar/${data.username}`,
            follower_count: 85200,
            is_live: data.isLive,
            platform: "TikTok",
            bio: "TikTok creator resolved live via ApiServer."
          }]);
        } else {
          setSearchResults([]);
          setSearchError({ message: 'Creator not found' });
        }
      } catch (err: any) {
        setSearchError({ message: 'Failed to search' });
      } finally {
        setSearchLoading(false);
      }
    }, 600);

    return () => clearTimeout(timer);
  }, [searchQuery]);

  const handleApiAdd = async (user: any) => {
    try {
      await fetch('/api/watchlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: user.username })
      });
      triggerToast(`Added @${user.username} to watchlist`);
      refetchWatchlist();
      setIsAdding(false);
      setSearchQuery('');
    } catch {
      triggerToast(`Failed to add @${user.username}`);
    }
  };

  const handleRemove = async (username: string) => {
    try {
      await fetch(`/api/watchlist/${username}`, { method: 'DELETE' });
      triggerToast(`🗑 Removed @${username}`);
      refetchWatchlist();
    } catch {
      triggerToast(`❌ Failed to remove @${username}`);
    }
  };

  return (
    <motion.div 
      initial={{ opacity: 0, x: 20 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -20 }}
      className="flex flex-col h-full w-full max-w-4xl mx-auto p-4 md:p-6 font-sans"
    >
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-bold tracking-tight text-white">Watchlist</h2>
        <button onClick={() => setIsAdding(true)} className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-[10px] font-bold uppercase tracking-widest rounded-full transition-colors flex items-center gap-2">
          <Plus className="w-4 h-4" /> Add Streamer
        </button>
      </div>

      <div className="flex flex-col gap-3 pb-20 md:pb-0">
        {watchlist.map(streamer => (
          <div key={streamer.id} className="flex items-center justify-between p-4 bg-zinc-900 border border-zinc-800 rounded-2xl hover:border-zinc-700 transition-colors">
            <div className="flex items-center gap-4">
              <div className="relative">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={streamer.avatar} alt={streamer.name} className="w-12 h-12 rounded-full border border-zinc-800 bg-zinc-950 object-cover" />
                {streamer.status === 'Live' && (
                  <div className="absolute -bottom-1 -right-1 w-4 h-4 bg-red-650 border border-zinc-900 rounded-full" />
                )}
              </div>
              <div className="flex flex-col">
                <span className="font-bold text-sm text-white">@{streamer.username}</span>
                <span className="text-[10px] text-zinc-500 uppercase tracking-widest">{streamer.platform} • {streamer.status}</span>
              </div>
            </div>

            <div className="flex items-center gap-3">
              <button onClick={() => handleRemove(streamer.username)} className="p-2 text-zinc-500 hover:text-red-400 transition-colors">
                <Trash2 className="w-4.5 h-4.5" />
              </button>
            </div>
          </div>
        ))}
        {watchlist.length === 0 && (
          <div className="py-12 flex flex-col items-center text-zinc-500 text-sm">
            No streamers in your watchlist. Start adding some!
          </div>
        )}
      </div>

      <AnimatePresence>
        {isAdding && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-50 bg-[#050505]/90 backdrop-blur-sm flex flex-col items-center pt-24 px-4">
            <div className="w-full max-w-lg bg-zinc-900 border border-zinc-800 rounded-3xl p-6 shadow-2xl relative">
              <button onClick={() => { setIsAdding(false); setSearchQuery(''); setSearchError(null); setSearchResults([]); }} className="absolute top-4 right-4 text-zinc-500 hover:text-white transition-colors bg-zinc-800 rounded-full p-1">
                <X className="w-5 h-5" />
              </button>
              
              <h3 className="font-bold text-white text-lg mb-1">Search TikTok Creators</h3>
              <p className="text-[10px] uppercase font-mono text-zinc-500 mb-6">Real-time Integration</p>

              <div className="relative mb-4">
                <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-zinc-500" />
                <input 
                  type="text"
                  autoFocus
                  placeholder="e.g. highland.fashion7"
                  value={searchQuery}
                  onChange={(e) => handleSearchChange(e.target.value)}
                  className="w-full bg-zinc-950 border border-zinc-700 hover:border-zinc-650 focus:border-blue-500 transition-colors outline-none rounded-xl py-3 pl-12 pr-4 text-sm text-white placeholder:text-zinc-650"
                />
              </div>

              <div className="min-h-[120px] max-h-[300px] overflow-y-auto no-scrollbar">
                {searchLoading ? (
                  <div className="flex flex-col items-center justify-center p-8 gap-3">
                    <Loader2 className="w-6 h-6 text-blue-500 animate-spin" />
                    <span className="text-xs text-zinc-500 font-mono">Querying TikTok APIs...</span>
                  </div>
                ) : searchError ? (
                  <div className="text-center text-zinc-500 py-8">No results.</div>
                ) : searchResults.length > 0 ? (
                  <div className="flex flex-col gap-2 mt-2">
                    {searchResults.map((user: any) => (
                      <div key={user.username} className="flex items-center justify-between p-3 bg-zinc-950 border border-zinc-800 rounded-xl">
                        <div className="flex items-center gap-3">
                          <img alt={user.username} src={user.avatar_url} className="w-10 h-10 rounded-full border border-zinc-800 object-cover" />
                          <div className="flex flex-col">
                            <span className="font-bold text-sm text-white">@{user.username}</span>
                          </div>
                        </div>
                        <button onClick={() => handleApiAdd(user)} className="p-2 rounded-full bg-blue-600/20 text-blue-500 hover:bg-blue-600 hover:text-white transition-colors">
                          <Plus className="w-4 h-4" />
                        </button>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

// --- LIBRARY VIEW (DYNAMIC FILTERS AND PLAYBACK) ---

function LibraryView({ setCloudStatus, triggerToast }: {
  setCloudStatus: (s: 'connected' | 'syncing' | 'offline') => void,
  triggerToast: (msg: string) => void
}) {
  const [search, setSearch] = useState('');
  const [groupBy, setGroupBy] = useState<'date' | 'creator'>('date');
  const [sortBy, setSortBy] = useState<'latest' | 'oldest' | 'longest' | 'shortest'>('latest');
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [recordings, setRecordings] = useState<Recording[]>([]);
  const [expandedCreators, setExpandedCreators] = useState<Record<string, boolean>>({});

  const fetchRecordings = async () => {
    try {
      const res = await fetch('/api/recordings');
      const data = await res.json();
      const list = (data.recordings || []).map((r: any) => ({
        id: r.filename,
        title: `${r.username} Live Capture`,
        duration: r.duration || 120,
        timestamp: new Date(r.date),
        synced: !!r.driveFileId,
        thumbnail: r.thumb || `/api/avatar/${r.username}`,
        creatorName: r.username,
        creatorAvatar: `/api/avatar/${r.username}`,
        platform: 'TikTok',
        driveFileId: r.driveFileId,
        messageId: r.messageId,
        filename: r.filename,
        sizeMB: r.sizeMB
      }));
      setRecordings(list);
    } catch (err) {
      console.error(err);
    }
  };

  useEffect(() => {
    fetchRecordings();
  }, []);

  const handleSyncDrive = async () => {
    setCloudStatus('syncing');
    try {
      const res = await fetch('/api/drive/sync', { method: 'POST' });
      const data = await res.json();
      triggerToast(`Synced Drive! Added ${data.added || 0}, updated ${data.updated || 0}`);
      fetchRecordings();
    } catch {
      triggerToast('❌ Sync failed');
    } finally {
      setCloudStatus('connected');
    }
  };

  const items = recordings.filter(r => {
    const matchesSearch = r.title.toLowerCase().includes(search.toLowerCase()) || 
      (r.creatorName && r.creatorName.toLowerCase().includes(search.toLowerCase()));
    if (!matchesSearch) return false;
    return true;
  }).sort((a, b) => {
    const timeA = new Date(a.timestamp).getTime();
    const timeB = new Date(b.timestamp).getTime();
    if (sortBy === 'latest') return timeB - timeA;
    if (sortBy === 'oldest') return timeA - timeB;
    if (sortBy === 'longest') return b.duration - a.duration;
    if (sortBy === 'shortest') return a.duration - b.duration;
    return 0;
  });

  const getGroupedDates = (recs: Recording[]) => {
    const today: Recording[] = [];
    const yesterday: Recording[] = [];
    const thisWeek: Recording[] = [];
    const older: Recording[] = [];

    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const startOfYesterday = startOfToday - 1000 * 60 * 60 * 24;
    const startOfThisWeek = startOfToday - 1000 * 60 * 60 * 24 * 7;

    recs.forEach(item => {
      const time = new Date(item.timestamp).getTime();
      if (time >= startOfToday) today.push(item);
      else if (time >= startOfYesterday) yesterday.push(item);
      else if (time >= startOfThisWeek) thisWeek.push(item);
      else older.push(item);
    });

    return { today, yesterday, thisWeek, older };
  };

  const groupedDates = getGroupedDates(items);

  const groupedCreators = items.reduce((acc, item) => {
    const creatorKey = item.creatorName || 'Direct Ingest';
    if (!acc[creatorKey]) {
      acc[creatorKey] = {
        creatorName: creatorKey,
        creatorAvatar: item.creatorAvatar || '',
        platform: item.platform || 'TikTok',
        items: []
      };
    }
    acc[creatorKey].items.push(item);
    return acc;
  }, {} as Record<string, { creatorName: string, creatorAvatar: string, platform: string, items: Recording[] }>);

  const toggleCreatorExpand = (name: string) => {
    setExpandedCreators(prev => ({ ...prev, [name]: !prev[name] }));
  };

  const renderRowItem = (item: Recording) => (
    <div key={item.id} onClick={() => setPlayingId(item.id)} className="group flex flex-row gap-3 bg-zinc-900/40 hover:bg-zinc-900 border border-zinc-800/60 hover:border-zinc-700 rounded-2xl p-2.5 items-center transition-all cursor-pointer">
      <div className="relative w-20 h-12 rounded-lg overflow-hidden flex-shrink-0 bg-zinc-950">
        <img src={item.thumbnail} alt={item.title} className="w-full h-full object-cover opacity-80" />
      </div>
      <div className="flex-1 min-w-0 pr-1 flex flex-col gap-0.5">
        <h4 className="font-bold text-xs text-white group-hover:text-blue-400 transition-colors truncate">{item.title}</h4>
        <p className="text-[10px] text-zinc-550 font-mono">@{item.creatorName} • {formatSize(item.sizeMB)}</p>
      </div>
      <div className="w-8 h-8 rounded-full bg-zinc-800 flex items-center justify-center transition-all shrink-0">
        <Play className="w-3.5 h-3.5 fill-current ml-0.5" />
      </div>
    </div>
  );

  const renderGroupList = (recs: Recording[]) => {
    return (
      <div className="flex flex-col gap-2">
        {recs.map(renderRowItem)}
      </div>
    );
  };

  return (
    <motion.div initial={{ opacity: 0, y: 15 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -15 }} className="flex flex-col h-full w-full max-w-4xl mx-auto p-4 md:p-6 font-sans">
      <div className="flex flex-col gap-4 mb-4">
        <div className="flex items-center justify-between">
          <h2 className="text-2xl font-bold tracking-tight text-white flex items-center gap-2">
            <Film className="w-6 h-6 text-blue-500" /> Vault Library
          </h2>
          <button onClick={handleSyncDrive} className="px-3 py-1.5 bg-blue-650 hover:bg-blue-600 rounded-xl text-xs font-bold text-white transition-colors flex items-center gap-1">
            Retrieve Drive Sync
          </button>
        </div>

        <div className="flex flex-col sm:flex-row gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
            <input 
              type="text" 
              placeholder="Search library..." 
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="w-full bg-zinc-950 border border-zinc-800 rounded-2xl py-2.5 pl-10 pr-4 text-xs outline-none"
            />
          </div>

          <div className="flex bg-zinc-950 border border-zinc-800 p-0.5 rounded-xl">
            <button onClick={() => setGroupBy('date')} className={`flex items-center gap-1 px-3 py-1.5 text-xs font-bold rounded-lg ${groupBy === 'date' ? 'bg-zinc-900 text-blue-400' : 'text-zinc-550'}`}>
              <Calendar className="w-3.5 h-3.5" /> Date
            </button>
            <button onClick={() => setGroupBy('creator')} className={`flex items-center gap-1 px-3 py-1.5 text-xs font-bold rounded-lg ${groupBy === 'creator' ? 'bg-zinc-900 text-purple-400' : 'text-zinc-550'}`}>
              <Users className="w-3.5 h-3.5" /> Creator
            </button>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto no-scrollbar pb-24 md:pb-6 space-y-6">
        {groupBy === 'date' && (
          <div className="space-y-6">
            {groupedDates.today.length > 0 && (
              <div className="space-y-2.5">
                <span className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider">Today</span>
                {renderGroupList(groupedDates.today)}
              </div>
            )}
            {groupedDates.yesterday.length > 0 && (
              <div className="space-y-2.5">
                <span className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider">Yesterday</span>
                {renderGroupList(groupedDates.yesterday)}
              </div>
            )}
            {groupedDates.thisWeek.length > 0 && (
              <div className="space-y-2.5">
                <span className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider">Last 7 Days</span>
                {renderGroupList(groupedDates.thisWeek)}
              </div>
            )}
            {groupedDates.older.length > 0 && (
              <div className="space-y-2.5">
                <span className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider">Older</span>
                {renderGroupList(groupedDates.older)}
              </div>
            )}
          </div>
        )}

        {groupBy === 'creator' && (
          <div className="space-y-3.5">
            {Object.values(groupedCreators).map(creatorGroup => {
              const isOpen = !!expandedCreators[creatorGroup.creatorName];
              return (
                <div key={creatorGroup.creatorName} className="bg-zinc-950/60 border border-zinc-900 rounded-2xl overflow-hidden shadow-sm">
                  <div onClick={() => toggleCreatorExpand(creatorGroup.creatorName)} className="flex items-center justify-between p-3.5 cursor-pointer hover:bg-zinc-900/40 select-none">
                    <span className="font-bold text-xs">@{creatorGroup.creatorName}</span>
                    <span className="text-[10px] text-zinc-550 font-bold">{creatorGroup.items.length} files</span>
                  </div>
                  {isOpen && (
                    <div className="px-3 pb-3 border-t border-zinc-900/60 pt-3">
                      {renderGroupList(creatorGroup.items)}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* HTML5 Recording Video Player Modal */}
      <AnimatePresence>
        {playingId && (() => {
          const playingItem = items.find(i => i.id === playingId);
          if (!playingItem) return null;
          return (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-50 bg-[#050505]/95 backdrop-blur-lg flex items-center justify-center p-4">
              <div className="w-full max-w-5xl rounded-3xl overflow-hidden bg-zinc-900 border border-zinc-800 shadow-2xl flex flex-col">
                <div className="px-6 py-4 flex flex-row items-center justify-between border-b border-zinc-805/60 shrink-0">
                  <div className="flex flex-col">
                    <h3 className="font-bold text-white text-sm">{playingItem.title}</h3>
                    <span className="text-[10px] text-zinc-505 font-bold uppercase tracking-widest">
                      {playingItem.driveFileId ? 'Google Drive Stream' : playingItem.messageId ? 'Telegram Stream' : 'Local Stream'}
                    </span>
                  </div>
                  <button onClick={() => setPlayingId(null)} className="w-10 h-10 rounded-full bg-zinc-800 hover:bg-zinc-700 flex items-center justify-center">
                    <X className="w-5 h-5 text-zinc-400" />
                  </button>
                </div>
                <div className="relative aspect-video bg-black w-full flex items-center justify-center">
                  <video
                    className="w-full h-full object-contain"
                    controls
                    autoPlay
                    src={
                      playingItem.driveFileId
                        ? `/api/drive/video/${playingItem.driveFileId}`
                        : playingItem.messageId
                        ? `/api/telegram/video/${playingItem.messageId}`
                        : `/recordings/${playingItem.filename}`
                    }
                  />
                </div>
              </div>
            </motion.div>
          );
        })()}
      </AnimatePresence>
    </motion.div>
  );
}

// --- SETTINGS VIEW ---

function SettingsView() {
  return (
    <motion.div initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }} className="flex flex-col h-full w-full max-w-2xl mx-auto p-4 md:p-6 font-sans">
      <h2 className="text-2xl font-bold tracking-tight mb-8 text-white">Settings</h2>
      
      <div className="space-y-6">
        <section className="bg-zinc-900 border border-zinc-800 rounded-3xl p-5 md:p-6">
          <div className="flex items-center gap-4 mb-6">
            <CloudCog className="w-6 h-6 text-blue-500" />
            <div>
              <h3 className="font-bold text-white">Cloud Storage Sync</h3>
            </div>
          </div>
          <div className="space-y-3">
            <div className="flex flex-row items-center justify-between p-3 rounded-2xl bg-[#050505] border border-zinc-800">
              <span className="text-sm font-bold text-zinc-300 pl-2">Telegram / Google Drive Vaults</span>
              <span className="text-xs text-green-400 font-bold pr-2">Online</span>
            </div>
          </div>
        </section>
      </div>
    </motion.div>
  );
}
