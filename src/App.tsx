/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef, useCallback } from 'react';
import { Upload, Image as ImageIcon, Download, Scissors, Loader2, Trash2, ArchiveRestore } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import JSZip from 'jszip';
import { saveAs } from 'file-saver';

export default function App() {
  const [status, setStatus] = useState<'idle' | 'processing' | 'done'>('idle');
  const [originalImage, setOriginalImage] = useState<string | null>(null);
  const [stickers, setStickers] = useState<string[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      processFile(file);
    }
  };

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (file && file.type.startsWith('image/')) {
      processFile(file);
    }
  }, []);

  const processFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const result = e.target?.result as string;
      setOriginalImage(result);
      setStatus('processing');
      // Use setTimeout to allow UI to render the 'processing' state before heavy lifting
      setTimeout(() => {
        segmentStickers(result);
      }, 50);
    };
    reader.readAsDataURL(file);
  };

  const segmentStickers = (imageUrl: string) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return;

      canvas.width = img.width;
      canvas.height = img.height;
      ctx.drawImage(img, 0, 0);

      const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const data = imgData.data;
      const width = canvas.width;
      const height = canvas.height;

      // 1. Flood Fill Background to Transparent
      // Assume top-left corner is the background color
      const bgR = data[0];
      const bgG = data[1];
      const bgB = data[2];
      const tolerance = 18; // Low tolerance to stop at drop shadows

      const colorMatch = (i: number) => {
        return Math.abs(data[i] - bgR) <= tolerance &&
               Math.abs(data[i + 1] - bgG) <= tolerance &&
               Math.abs(data[i + 2] - bgB) <= tolerance;
      };

      const visited = new Uint8Array(width * height);
      const stackX = new Int32Array(width * height);
      const stackY = new Int32Array(width * height);
      let stackPtr = 0;

      // Start from 4 corners just to be safe
      const startPoints = [
        [0, 0], [width - 1, 0], [0, height - 1], [width - 1, height - 1]
      ];

      for (const [startX, startY] of startPoints) {
          const startIdx = startY * width + startX;
          if (visited[startIdx] === 0 && colorMatch(startIdx * 4)) {
              stackX[stackPtr] = startX;
              stackY[stackPtr] = startY;
              stackPtr++;
              visited[startIdx] = 1;
          }
      }

      while (stackPtr > 0) {
        stackPtr--;
        const x = stackX[stackPtr];
        const y = stackY[stackPtr];
        const idx = (y * width + x) * 4;

        // Make pixel transparent
        data[idx + 3] = 0; 

        // 4-way neighbors
        const neighbors = [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]];
        for (const [nx, ny] of neighbors) {
          if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
            const nIdxMap = ny * width + nx;
            if (visited[nIdxMap] === 0) {
              visited[nIdxMap] = 1;
              const nIdxData = nIdxMap * 4;
              if (colorMatch(nIdxData)) {
                stackX[stackPtr] = nx;
                stackY[stackPtr] = ny;
                stackPtr++;
              }
            }
          }
        }
      }

      // 1.5 Erode object (dilate background) by 1 pixel to remove fringe
      const dilatedBg = new Uint8Array(width * height);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const idxMap = y * width + x;
          if (data[idxMap * 4 + 3] === 0) {
            dilatedBg[idxMap] = 1;
            if (x > 0) dilatedBg[y * width + (x - 1)] = 1;
            if (x < width - 1) dilatedBg[y * width + (x + 1)] = 1;
            if (y > 0) dilatedBg[(y - 1) * width + x] = 1;
            if (y < height - 1) dilatedBg[(y + 1) * width + x] = 1;
          }
        }
      }
      for (let i = 0; i < width * height; i++) {
        if (dilatedBg[i]) data[i * 4 + 3] = 0;
      }

      // 1.6 Blur the alpha channel slightly for anti-aliasing edge
      const alphaBuffer = new Uint8Array(width * height);
      for (let i = 0; i < width * height; i++) {
        alphaBuffer[i] = data[i * 4 + 3];
      }
      for (let y = 1; y < height - 1; y++) {
        for (let x = 1; x < width - 1; x++) {
           const idx0 = (y - 1) * width + x;
           const idx1 = y * width + x;
           const idx2 = (y + 1) * width + x;
           
           const sum = 
             alphaBuffer[idx0 - 1] + alphaBuffer[idx0] + alphaBuffer[idx0 + 1] +
             alphaBuffer[idx1 - 1] + alphaBuffer[idx1] + alphaBuffer[idx1 + 1] +
             alphaBuffer[idx2 - 1] + alphaBuffer[idx2] + alphaBuffer[idx2 + 1];

           data[idx1 * 4 + 3] = sum / 9;
        }
      }

      // 1.7 Commit the transparent and softened pixels to the main canvas
      ctx.putImageData(imgData, 0, 0);

      // --- 2. MORPHOLOGICAL EROSION & WATERSHED ---
      const M = new Uint8Array(width * height);
      for (let i = 0; i < width * height; i++) {
        if (data[i * 4 + 3] > 10) M[i] = 1;
      }

      const getCores = (R: number) => {
          const E = new Uint8Array(width * height);
          if (R === 0) {
              for (let i = 0; i < width * height; i++) E[i] = M[i];
          } else {
              const E_horiz = new Uint8Array(width * height);
              for (let y = 0; y < height; y++) {
                  let sum = 0;
                  for (let x = 0; x <= R && x < width; x++) sum += M[y * width + x];
                  for (let x = 0; x < width; x++) {
                     const minX = Math.max(0, x - R);
                     const maxX = Math.min(width - 1, x + R);
                     if (sum === maxX - minX + 1) E_horiz[y * width + x] = 1;
                     
                     if (x - R >= 0) sum -= M[y * width + (x - R)];
                     if (x + R + 1 < width) sum += M[y * width + (x + R + 1)];
                  }
              }

              for (let x = 0; x < width; x++) {
                  let sum = 0;
                  for (let y = 0; y <= R && y < height; y++) sum += E_horiz[y * width + x];
                  for (let y = 0; y < height; y++) {
                     const minY = Math.max(0, y - R);
                     const maxY = Math.min(height - 1, y + R);
                     if (sum === maxY - minY + 1) E[y * width + x] = 1;
                     
                     if (y - R >= 0) sum -= E_horiz[(y - R) * width + x];
                     if (y + R + 1 < height) sum += E_horiz[(y + R + 1) * width + x];
                  }
              }
          }

          const coreLabels = new Int32Array(width * height);
          let currentLabel = 1;
          const coreQueue = new Int32Array(width * height);
          const activeCores = [];

          for (let y = 0; y < height; y++) {
              for (let x = 0; x < width; x++) {
                  const idx = y * width + x;
                  if (E[idx] === 1 && coreLabels[idx] === 0) {
                      let qHead = 0, qTail = 0;
                      coreQueue[qTail++] = idx;
                      coreLabels[idx] = currentLabel;
                      let count = 1;
                      
                      while (qHead < qTail) {
                          const cIdx = coreQueue[qHead++];
                          const cx = cIdx % width;
                          const cy = Math.floor(cIdx / width);
                          
                          if (cx > 0 && E[cIdx - 1] === 1 && coreLabels[cIdx - 1] === 0) {
                             coreLabels[cIdx - 1] = currentLabel;
                             coreQueue[qTail++] = cIdx - 1;
                             count++;
                          }
                          if (cx < width - 1 && E[cIdx + 1] === 1 && coreLabels[cIdx + 1] === 0) {
                             coreLabels[cIdx + 1] = currentLabel;
                             coreQueue[qTail++] = cIdx + 1;
                             count++;
                          }
                          if (cy > 0 && E[cIdx - width] === 1 && coreLabels[cIdx - width] === 0) {
                             coreLabels[cIdx - width] = currentLabel;
                             coreQueue[qTail++] = cIdx - width;
                             count++;
                          }
                          if (cy < height - 1 && E[cIdx + width] === 1 && coreLabels[cIdx + width] === 0) {
                             coreLabels[cIdx + width] = currentLabel;
                             coreQueue[qTail++] = cIdx + width;
                             count++;
                          }
                      }
                      
                      if (count > 20) {
                          activeCores.push(currentLabel);
                          currentLabel++;
                      } else {
                          for(let i = 0; i < qTail; i++) coreLabels[coreQueue[i]] = 0;
                      }
                  }
              }
          }
          return { coreLabels, activeCores };
      };

      let { coreLabels, activeCores } = getCores(15);
      if (activeCores.length === 0) {
          const res = getCores(8);
          coreLabels = res.coreLabels;
          activeCores = res.activeCores;
      }
      if (activeCores.length === 0) {
          const res = getCores(0);
          coreLabels = res.coreLabels;
          activeCores = res.activeCores;
      }

      const finalLabels = new Int32Array(width * height);
      const queue = new Int32Array(width * height);
      let qHead = 0, qTail = 0;

      for (let i = 0; i < width * height; i++) {
          if (coreLabels[i] > 0) {
              finalLabels[i] = coreLabels[i];
              queue[qTail++] = i;
          }
      }

      while (qHead < qTail) {
          const idx = queue[qHead++];
          const L = finalLabels[idx];
          const x = idx % width;
          const y = Math.floor(idx / width);
          
          if (x > 0 && finalLabels[idx - 1] === 0) {
              finalLabels[idx - 1] = L;
              queue[qTail++] = idx - 1;
          }
          if (x < width - 1 && finalLabels[idx + 1] === 0) {
              finalLabels[idx + 1] = L;
              queue[qTail++] = idx + 1;
          }
          if (y > 0 && finalLabels[idx - width] === 0) {
              finalLabels[idx - width] = L;
              queue[qTail++] = idx - width;
          }
          if (y < height - 1 && finalLabels[idx + width] === 0) {
              finalLabels[idx + width] = L;
              queue[qTail++] = idx + width;
          }
      }

      const bounds = new Map<number, {minX: number, maxX: number, minY: number, maxY: number, pixels: number}>();
      for (let y = 0; y < height; y++) {
          for (let x = 0; x < width; x++) {
              const idx = y * width + x;
              if (M[idx] === 1) {
                  const L = finalLabels[idx];
                  if (L > 0) {
                      let b = bounds.get(L);
                      if (!b) {
                          b = { minX: x, maxX: x, minY: y, maxY: y, pixels: 1 };
                          bounds.set(L, b);
                      } else {
                          if (x < b.minX) b.minX = x;
                          if (x > b.maxX) b.maxX = x;
                          if (y < b.minY) b.minY = y;
                          if (y > b.maxY) b.maxY = y;
                          b.pixels++;
                      }
                  }
              }
          }
      }

      const stickersData: string[] = [];
      const padding = 10;
      
      for (const [label, b] of bounds.entries()) {
          const w = b.maxX - b.minX;
          const h = b.maxY - b.minY;
          
          if (w > 40 && h > 40 && b.pixels > 300) {
              const sMinX = Math.max(0, b.minX - padding);
              const sMinY = Math.max(0, b.minY - padding);
              const sMaxX = Math.min(width, b.maxX + padding);
              const sMaxY = Math.min(height, b.maxY + padding);
              const sW = sMaxX - sMinX;
              const sH = sMaxY - sMinY;

              const rawCanvas = document.createElement('canvas');
              rawCanvas.width = sW;
              rawCanvas.height = sH;
              const rawCtx = rawCanvas.getContext('2d');
              
              if (rawCtx) {
                  const stickerImgData = rawCtx.createImageData(sW, sH);
                  
                  for (let sy = 0; sy < sH; sy++) {
                      for (let sx = 0; sx < sW; sx++) {
                          const oy = sMinY + sy;
                          const ox = sMinX + sx;
                          if (oy >= 0 && oy < height && ox >= 0 && ox < width) {
                              const oIdx = oy * width + ox;
                              const pLabel = finalLabels[oIdx];
                              
                              if (M[oIdx] === 1 && pLabel === label) {
                                  const sIdx = (sy * sW + sx) * 4;
                                  stickerImgData.data[sIdx] = data[oIdx * 4];
                                  stickerImgData.data[sIdx + 1] = data[oIdx * 4 + 1];
                                  stickerImgData.data[sIdx + 2] = data[oIdx * 4 + 2];
                                  stickerImgData.data[sIdx + 3] = data[oIdx * 4 + 3];
                              }
                          }
                      }
                  }
                  rawCtx.putImageData(stickerImgData, 0, 0);

                  const strokePad = 14;
                  const finalCanvas = document.createElement('canvas');
                  finalCanvas.width = sW + strokePad * 2;
                  finalCanvas.height = sH + strokePad * 2;
                  const fCtx = finalCanvas.getContext('2d');

                  if (fCtx) {
                      fCtx.imageSmoothingEnabled = true;
                      
                      const strokeThickness = 8;
                      const points = 36;
                      for (let i = 0; i < points; i++) {
                          const angle = (i * 2 * Math.PI) / points;
                          const dx = Math.cos(angle) * strokeThickness;
                          const dy = Math.sin(angle) * strokeThickness;
                          fCtx.drawImage(rawCanvas, strokePad + dx, strokePad + dy);
                      }

                      fCtx.globalCompositeOperation = 'source-in';
                      fCtx.fillStyle = '#ffffff';
                      fCtx.fillRect(0, 0, finalCanvas.width, finalCanvas.height);

                      fCtx.globalCompositeOperation = 'source-over';
                      fCtx.drawImage(rawCanvas, strokePad, strokePad);

                      stickersData.push(finalCanvas.toDataURL('image/png'));
                  }
              }
          }
      }

      setStickers(stickersData);
      setStatus('done');
    };
    img.src = imageUrl;
  };

  const handleDownload = (dataUrl: string, index: number) => {
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = `sticker_${index + 1}.png`;
    a.click();
  };

  const handleDownloadAll = async () => {
    const zip = new JSZip();
    
    stickers.forEach((stickerDataUrl, index) => {
      // Extract base64 payload from data url
      const base64Data = stickerDataUrl.split(',')[1];
      zip.file(`sticker_${String(index + 1).padStart(2, '0')}.png`, base64Data, {base64: true});
    });

    const content = await zip.generateAsync({ type: 'blob' });
    saveAs(content, 'stickers.zip');
  };

  const handleReset = () => {
    setOriginalImage(null);
    setStickers([]);
    setStatus('idle');
  };

  return (
    <div className="min-h-screen bg-emerald-50 text-slate-900 font-sans flex flex-col overflow-hidden">
      {/* Header */}
      <header className="h-20 bg-white border-b-4 border-emerald-200 px-6 md:px-8 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-rose-500 rounded-xl flex items-center justify-center rotate-3 shadow-lg">
            <Scissors className="w-6 h-6 text-white" />
          </div>
          <h1 className="text-2xl font-black tracking-tight text-slate-800">
            Tách Sticker<span className="text-rose-500"> Tự Động</span>
          </h1>
        </div>
        <nav className="flex gap-6 items-center">
          <span className="bg-emerald-100 text-emerald-700 px-3 py-1 rounded-full text-xs font-bold uppercase tracking-wider hidden sm:inline-block">Công Cụ AI</span>
          <div className="w-8 h-8 sm:w-10 h-10 rounded-full bg-slate-200 border-2 border-emerald-400 overflow-hidden flex items-center justify-center">
            <ImageIcon className="w-4 h-4 text-slate-400" />
          </div>
        </nav>
      </header>

      {/* Main Content Area */}
      <main className="flex-1 p-4 sm:p-6 flex flex-col items-center w-full overflow-y-auto">
        <div className="w-full max-w-5xl flex flex-col gap-6 items-center">
          <div className="text-center space-y-2 max-w-lg mt-4 mb-4">
            <p className="text-slate-500 font-medium">
              Tải lên một khung ảnh chứa nhiều sticker. Hệ thống sẽ ngay lập tức tự động tìm kiếm, tách rời và xóa phông nền để bạn tải về từng hình rực rỡ riêng lẻ.
            </p>
          </div>

          <AnimatePresence mode="wait">
            {status === 'idle' && (
              <motion.div
                key="upload"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                className="w-full max-w-3xl bg-white rounded-3xl p-6 md:p-8 shadow-xl border-2 border-slate-100 flex flex-col"
              >
                <h2 className="text-lg font-bold mb-6 flex items-center gap-2">
                  <span className="w-6 h-6 bg-yellow-400 rounded-full inline-flex items-center justify-center text-xs text-white">1</span>
                  Tải Lên Bảng Ảnh Gốc
                </h2>
                
                <div
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={handleDrop}
                  onClick={() => fileInputRef.current?.click()}
                  className="relative flex-1 bg-slate-50 border-4 border-dashed border-slate-200 rounded-2xl p-12 sm:p-24 flex flex-col items-center justify-center text-center cursor-pointer hover:bg-slate-100 hover:border-rose-400 transition-all duration-300 shadow-inner group"
                >
                  <input
                    type="file"
                    accept="image/*"
                    className="hidden"
                    ref={fileInputRef}
                    onChange={handleFileUpload}
                  />
                  
                  <div className="bg-rose-100 w-20 h-20 rounded-2xl flex items-center justify-center text-rose-500 mb-6 rotate-6 group-hover:scale-110 group-hover:-rotate-3 transition-transform duration-300 shadow-lg border-2 border-rose-200">
                    <Upload className="w-10 h-10" />
                  </div>
                  
                  <h3 className="text-xl font-bold text-slate-700 mb-2">Nhấn để tải ảnh lên, hoặc kéo thả</h3>
                  <p className="text-slate-400 font-medium text-sm">Nền trắng hoặc màu trơn hoạt động tốt nhất</p>
                  
                  <button className="mt-8 bg-slate-800 text-white px-8 py-3 rounded-full font-bold shadow-lg hover:bg-slate-700 transition-colors pointer-events-none uppercase tracking-wide text-sm">
                    Chọn Ảnh
                  </button>
                </div>
              </motion.div>
            )}

            {status === 'processing' && (
              <motion.div
                key="processing"
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.95 }}
                className="w-full max-w-md bg-white rounded-3xl p-12 shadow-xl border-2 border-slate-100 flex flex-col items-center justify-center my-12"
              >
                <div className="relative">
                  <Loader2 className="w-20 h-20 text-rose-500 animate-spin" />
                  <div className="absolute inset-0 flex items-center justify-center">
                    <Scissors className="w-8 h-8 text-rose-300" />
                  </div>
                </div>
                <h3 className="mt-6 text-xl font-black text-slate-800">Đang cắt dán...</h3>
                <p className="text-slate-400 mt-2 text-sm font-medium text-center">
                  Hệ thống đang nhận diện các nhãn dán trong ảnh.
                </p>
              </motion.div>
            )}

            {status === 'done' && (
              <motion.div
                key="results"
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                className="w-full bg-white rounded-3xl p-6 md:p-8 shadow-xl border-2 border-slate-100 flex flex-col"
              >
                <div className="flex flex-col sm:flex-row items-center justify-between gap-4 mb-8">
                  <h2 className="text-xl font-bold flex items-center gap-2">
                    <span className="w-6 h-6 bg-indigo-500 rounded-full inline-flex items-center justify-center text-xs text-white">2</span>
                    Đã Tách Được ({stickers.length})
                  </h2>
                  <div className="flex gap-2">
                    {stickers.length > 0 && (
                      <button
                        onClick={handleDownloadAll}
                        className="text-white bg-indigo-600 border-2 border-indigo-600 px-5 py-2 rounded-xl font-bold text-sm flex items-center gap-2 hover:bg-indigo-700 hover:border-indigo-700 transition shadow-lg shrink-0"
                      >
                        <ArchiveRestore className="w-4 h-4" />
                        Tải tất cả
                      </button>
                    )}
                    <button
                      onClick={handleReset}
                      className="text-white bg-slate-800 border-2 border-slate-800 px-5 py-2 rounded-xl font-bold text-sm flex items-center gap-2 hover:bg-slate-700 hover:border-slate-700 transition shadow-lg shrink-0"
                    >
                      <Trash2 className="w-4 h-4" />
                      Bắt đầu lại
                    </button>
                  </div>
                </div>

                {stickers.length === 0 ? (
                  <div className="text-center py-12 border-2 border-dashed border-slate-200 rounded-2xl bg-slate-50">
                    <ImageIcon className="w-12 h-12 text-slate-300 mx-auto mb-3" />
                    <h3 className="font-bold text-slate-600">Không tìm thấy sticker</h3>
                    <p className="text-slate-400 text-sm mt-1">Vui lòng thử lại với ảnh khác có nền đồng nhất.</p>
                  </div>
                ) : (
                  <div className="flex-1 grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4 md:gap-6">
                    {stickers.map((sticker, idx) => (
                      <motion.div
                        initial={{ opacity: 0, scale: 0.8 }}
                        animate={{ opacity: 1, scale: 1 }}
                        transition={{ delay: idx * 0.05 }}
                        key={idx}
                        className="group relative flex flex-col items-center bg-slate-50 rounded-2xl p-4 border border-slate-100 hover:border-indigo-200 transition-colors"
                      >
                        {/* Checkered background wrapper */}
                        <div className="w-full aspect-square bg-[radial-gradient(#cbd5e1_1px,transparent_1px)] [background-size:10px_10px] rounded-xl flex items-center justify-center shadow-inner mb-3 overflow-hidden relative border border-slate-100">
                          <img 
                            src={sticker} 
                            alt={`Sticker ${idx + 1}`} 
                            className="max-w-[85%] max-h-[85%] object-contain drop-shadow-xl group-hover:scale-110 transition-transform duration-300 pointer-events-none"
                          />
                        </div>
                        
                        <span className="text-[10px] font-mono text-slate-400 mb-2 truncate max-w-full px-2">
                          sticker_{String(idx + 1).padStart(2, '0')}.png
                        </span>
                        
                        <button
                          onClick={() => handleDownload(sticker, idx)}
                          className="w-full bg-white border border-slate-200 py-2 rounded-lg text-xs font-bold text-slate-600 hover:bg-indigo-50 hover:text-indigo-600 hover:border-indigo-200 transition-colors flex items-center justify-center gap-1.5 shadow-sm active:translate-y-px"
                        >
                          <Download className="w-3.5 h-3.5" />
                          LƯU ẢNH
                        </button>
                      </motion.div>
                    ))}
                  </div>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </main>

      {/* Footer Status Bar */}
      <footer className="h-10 bg-slate-800 text-white/50 text-[10px] px-4 sm:px-8 flex items-center justify-between uppercase tracking-widest shrink-0 mt-auto">
        <div className="flex gap-4">
          <span className="hidden sm:inline">Phân tích: Pixel Scan</span>
          <span className="hidden sm:inline">Định dạng: PNG (Trong suốt)</span>
          <span>Tệp: {status === 'idle' ? 'Chờ' : stickers.length}</span>
        </div>
        <div className="text-emerald-400 font-bold flex items-center gap-2">
          Hệ thống sẵn sàng
          <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
        </div>
      </footer>
    </div>
  );
}
