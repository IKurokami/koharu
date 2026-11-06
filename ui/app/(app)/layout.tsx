'use client'

import { MenuBar } from '@/components/MenuBar'
import { FlickeringGrid } from '@/components/FlickeringGrid'

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className='relative flex h-screen w-screen flex-col overflow-hidden bg-background'>
      {/* Global Animated Flickering Grid Background */}
      <div className='absolute inset-0 pointer-events-none z-0 opacity-25 dark:opacity-[0.14]'>
        <FlickeringGrid
          squareSize={4}
          gridGap={6}
          flickerChance={0.2}
          color="rgb(99, 102, 241)"
          maxOpacity={0.2}
        />
      </div>
      
      {/* Main App Content Stack */}
      <div className='relative z-10 flex flex-col h-full w-full min-h-0 overflow-hidden bg-transparent'>
        <MenuBar />
        {children}
      </div>
    </div>
  )
}
