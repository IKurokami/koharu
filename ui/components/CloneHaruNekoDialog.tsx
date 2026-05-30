'use client'

import { useState } from 'react'
import { 
  GitBranchIcon, 
  Loader2Icon, 
  CheckCircle2Icon, 
  AlertCircleIcon, 
  SearchIcon,
  FileCodeIcon,
  SparklesIcon
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Input } from '@/components/ui/input'
import { 
  Dialog, 
  DialogContent, 
  DialogHeader, 
  DialogTitle, 
  DialogDescription 
} from '@/components/ui/dialog'
import { useCloneConnectors } from '@/lib/api/default/default'

interface CloneHaruNekoDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function CloneHaruNekoDialog({ open, onOpenChange }: CloneHaruNekoDialogProps) {
  const [filterQuery, setFilterQuery] = useState<string>('')
  const [error, setError] = useState<string | null>(null)
  const [clonedFiles, setClonedFiles] = useState<string[]>([])
  const [cloningStatus, setCloningStatus] = useState<'idle' | 'cloning' | 'done'>('idle')

  const cloneConnectorsMutation = useCloneConnectors()

  const handleStartClone = async () => {
    setCloningStatus('cloning')
    setError(null)
    setClonedFiles([])

    try {
      const res = await cloneConnectorsMutation.mutateAsync({
        data: {
          targetDir: '' // Pass empty so the backend automatically uses system_scripts_dir
        }
      })
      if (res.success) {
        setClonedFiles(res.files || [])
        setCloningStatus('done')
      } else {
        setError(res.message || 'Đồng bộ thất bại.')
        setCloningStatus('idle')
      }
    } catch (e) {
      console.error(e)
      setError(e instanceof Error ? e.message : 'Lỗi kết nối với backend hoặc tiến trình đồng bộ gặp lỗi.')
      setCloningStatus('idle')
    }
  }

  const filteredFiles = clonedFiles.filter(f => 
    f.toLowerCase().includes(filterQuery.toLowerCase())
  )

  return (
    <Dialog open={open} onOpenChange={(val) => {
      onOpenChange(val)
      if (!val) {
        setCloningStatus('idle')
        setError(null)
      }
    }}>
      <DialogContent className="sm:max-w-2xl max-h-[85vh] flex flex-col p-6 overflow-hidden bg-background/95 backdrop-blur-xl border border-border/50 shadow-2xl rounded-2xl transition-all duration-300">
        
        <DialogHeader className="border-b border-border/40 pb-4 mb-2 shrink-0">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-xl bg-primary/10 flex items-center justify-center text-primary border border-primary/20 shrink-0">
              <GitBranchIcon className="h-5 w-5" />
            </div>
            <div>
              <DialogTitle className="text-xl font-semibold tracking-tight text-foreground flex items-center gap-2">
                Đồng bộ Scripts HaruNeko
              </DialogTitle>
              <DialogDescription className="text-xs text-muted-foreground mt-0.5">
                Tải xuống và cài đặt toàn bộ các website connector scrapers từ kho HaruNeko vào thư mục hệ thống Koharu.
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        {error && (
          <div className="flex items-start gap-2.5 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-xs text-destructive mb-3 shrink-0">
            <AlertCircleIcon className="mt-0.5 h-4 w-4 shrink-0" />
            <div className="flex-1 font-medium">{error}</div>
          </div>
        )}

        <div className="flex-1 overflow-hidden flex flex-col gap-4 py-2">
          {cloningStatus === 'idle' && (
            <div className="flex-grow flex flex-col justify-center gap-6 max-w-lg mx-auto w-full py-4">
              <div className="text-center flex flex-col items-center gap-2">
                <SparklesIcon className="h-12 w-12 text-primary/80 animate-pulse" />
                <h3 className="font-semibold text-sm text-foreground">Đồng bộ Nguồn Truyện Tự Động</h3>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  Koharu sẽ thực hiện Git clone nông tự động và thiết lập các website download scrapers từ HaruNeko trực tiếp vào thư mục dữ liệu ứng dụng của hệ thống để tích hợp sử dụng nhanh chóng.
                </p>
              </div>

              <Button 
                onClick={handleStartClone}
                className="w-full h-11 text-xs font-semibold cursor-pointer rounded-lg bg-primary hover:bg-primary/90 text-primary-foreground shadow-lg shadow-primary/20"
              >
                Bắt đầu Đồng bộ & Cài đặt
              </Button>
            </div>
          )}

          {cloningStatus === 'cloning' && (
            <div className="flex-1 flex flex-col items-center justify-center text-center gap-4">
              <div className="relative flex items-center justify-center">
                <Loader2Icon className="h-12 w-12 text-primary animate-spin" />
                <GitBranchIcon className="h-5 w-5 text-primary absolute" />
              </div>
              <div className="flex flex-col gap-1.5">
                <h3 className="font-semibold text-sm text-foreground">Đang tải và đồng bộ các scripts...</h3>
                <p className="text-xs text-muted-foreground max-w-xs leading-relaxed">
                  Vui lòng giữ kết nối internet ổn định. Koharu đang tải các scraper files và tích hợp chúng vào hệ thống.
                </p>
              </div>
            </div>
          )}

          {cloningStatus === 'done' && (
            <div className="flex-1 overflow-hidden flex flex-col gap-4">
              <div className="flex items-center gap-3 p-3.5 rounded-xl border border-emerald-500/20 bg-emerald-500/5 text-emerald-400 shrink-0">
                <CheckCircle2Icon className="h-5 w-5 shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="font-semibold text-xs text-foreground">Đồng bộ hoàn tất!</div>
                  <div className="text-[10px] text-muted-foreground">
                    Đã cài đặt {clonedFiles.length} scripts thành công vào hệ thống Koharu.
                  </div>
                </div>
              </div>

              {/* Search Bar for cloned scripts */}
              <div className="relative shrink-0">
                <SearchIcon className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input 
                  placeholder="Tìm kiếm các website hỗ trợ..."
                  value={filterQuery}
                  onChange={(e) => setFilterQuery(e.target.value)}
                  className="pl-9 h-9 bg-card/40 border-none focus-visible:ring-0 focus-visible:ring-offset-0 shadow-none rounded-lg text-xs outline-none"
                />
              </div>

              {/* Cloned files list */}
              <ScrollArea className="flex-1 pr-1">
                <div className="grid grid-cols-2 gap-2 pb-2">
                  {filteredFiles.map((file, idx) => (
                    <div 
                      key={idx}
                      className="flex items-center gap-2 p-2 rounded-lg border border-border/40 bg-card/10 hover:border-border/60 hover:bg-card/25 transition-all text-xs text-foreground/80 font-mono truncate"
                    >
                      <FileCodeIcon className="h-3.5 w-3.5 text-primary shrink-0" />
                      <span className="truncate">{file}</span>
                    </div>
                  ))}
                  {filteredFiles.length === 0 && (
                    <div className="col-span-2 text-center py-6 text-xs text-muted-foreground">
                      Không tìm thấy file nào khớp với từ khóa.
                    </div>
                  )}
                </div>
              </ScrollArea>

              <div className="shrink-0 flex justify-end pt-2 border-t border-border/40">
                <Button 
                  onClick={() => onOpenChange(false)}
                  className="h-9 px-4 text-xs font-semibold cursor-pointer rounded-lg"
                >
                  Đóng
                </Button>
              </div>
            </div>
          )}
        </div>

      </DialogContent>
    </Dialog>
  )
}
