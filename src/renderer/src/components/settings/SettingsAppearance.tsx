import { useRef } from 'react'
import { THEME_PRESETS, ThemePreset } from '@/lib/themes'
import { useThemeStore } from '@/stores/useThemeStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { cn } from '@/lib/utils'
import { Check, Upload, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { toast } from '@/lib/toast'
import hiveLogo from '@/assets/icon.png'

/** Longest edge (px) the custom logo is downscaled to before being stored as a data URL. */
const MAX_LOGO_DIM = 128

/** Read an image file and return a downscaled PNG data URL (keeps the persisted settings blob small). */
function fileToResizedDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('Failed to read file'))
    reader.onload = () => {
      const img = new Image()
      img.onerror = () => reject(new Error('Failed to load image'))
      img.onload = () => {
        const scale = Math.min(1, MAX_LOGO_DIM / Math.max(img.width, img.height))
        const w = Math.max(1, Math.round(img.width * scale))
        const h = Math.max(1, Math.round(img.height * scale))
        const canvas = document.createElement('canvas')
        canvas.width = w
        canvas.height = h
        const ctx = canvas.getContext('2d')
        if (!ctx) {
          reject(new Error('Canvas not supported'))
          return
        }
        ctx.drawImage(img, 0, 0, w, h)
        resolve(canvas.toDataURL('image/png'))
      }
      img.src = reader.result as string
    }
    reader.readAsDataURL(file)
  })
}

function BrandingSection(): React.JSX.Element {
  const customLogoDataUrl = useSettingsStore((s) => s.customLogoDataUrl)
  const customAppName = useSettingsStore((s) => s.customAppName)
  const updateSetting = useSettingsStore((s) => s.updateSetting)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const handleLogoSelect = async (e: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = e.target.files?.[0]
    if (fileInputRef.current) fileInputRef.current.value = ''
    if (!file) return
    if (!file.type.startsWith('image/')) {
      toast.error('Please choose an image file')
      return
    }
    try {
      const dataUrl = await fileToResizedDataUrl(file)
      await updateSetting('customLogoDataUrl', dataUrl)
      toast.success('Logo updated')
    } catch {
      toast.error('Failed to load image')
    }
  }

  return (
    <section className="space-y-3" data-testid="settings-branding">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        Branding
      </h3>
      <p className="text-sm text-muted-foreground">
        Customize the logo and name shown in the top-left of the title bar.
      </p>

      {/* Logo */}
      <div className="flex items-center gap-4">
        <div className="flex h-12 w-12 items-center justify-center overflow-hidden rounded-md border bg-muted/30">
          <img
            src={customLogoDataUrl || hiveLogo}
            alt="App logo preview"
            className="h-10 w-10 rounded object-contain"
            draggable={false}
            data-testid="branding-logo-preview"
          />
        </div>
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={handleLogoSelect}
              data-testid="branding-logo-input"
            />
            <Button
              variant="outline"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
              data-testid="branding-logo-upload"
            >
              <Upload className="h-4 w-4 mr-2" />
              Upload logo
            </Button>
            {customLogoDataUrl && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => updateSetting('customLogoDataUrl', null)}
                data-testid="branding-logo-reset"
              >
                <RotateCcw className="h-4 w-4 mr-2" />
                Reset
              </Button>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            PNG, JPG, SVG or WebP. Resized to {MAX_LOGO_DIM}px.
          </p>
        </div>
      </div>

      {/* Name */}
      <div className="space-y-2">
        <label className="text-sm font-medium">App name</label>
        <Input
          value={customAppName}
          onChange={(e) => updateSetting('customAppName', e.target.value)}
          placeholder="Hive"
          maxLength={40}
          className="max-w-xs text-sm"
          data-testid="branding-app-name"
        />
        <p className="text-xs text-muted-foreground">Leave empty to use the default name.</p>
      </div>
    </section>
  )
}

interface ThemeCardProps {
  preset: ThemePreset
  isActive: boolean
  onSelect: (id: string) => void
  onMouseEnter: (id: string) => void
  onMouseLeave: () => void
}

function ThemeCard({
  preset,
  isActive,
  onSelect,
  onMouseEnter,
  onMouseLeave
}: ThemeCardProps): React.JSX.Element {
  const { background, sidebar, primary, 'muted-foreground': mutedFg } = preset.previewColors

  return (
    <button
      onClick={() => onSelect(preset.id)}
      onMouseEnter={() => onMouseEnter(preset.id)}
      onMouseLeave={onMouseLeave}
      className={cn(
        'group relative flex flex-col gap-2 rounded-lg border p-2 text-left transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        isActive
          ? 'border-primary ring-2 ring-primary/30 bg-primary/5'
          : 'border-border hover:border-muted-foreground/40'
      )}
      aria-label={`Select ${preset.name} theme`}
      aria-pressed={isActive}
      data-testid={`theme-card-${preset.id}`}
    >
      {/* Preview swatch */}
      <div
        className="relative h-16 w-full overflow-hidden rounded-md"
        style={{ backgroundColor: background }}
      >
        {/* Sidebar stripe — left edge */}
        <div
          className="absolute inset-y-0 left-0 w-[22%]"
          style={{ backgroundColor: sidebar }}
        />

        {/* Simulated text lines in main area */}
        <div className="absolute inset-y-0 left-[26%] right-0 flex flex-col justify-center gap-[4px] pr-2">
          <div
            className="h-[5px] w-3/4 rounded-full opacity-40"
            style={{ backgroundColor: mutedFg }}
          />
          <div
            className="h-[5px] w-1/2 rounded-full opacity-25"
            style={{ backgroundColor: mutedFg }}
          />
        </div>

        {/* Primary accent dot — bottom-right of main area */}
        <div
          className="absolute bottom-2 right-2 h-[10px] w-[10px] rounded-full"
          style={{ backgroundColor: primary }}
        />

        {/* Active check badge */}
        {isActive && (
          <div className="absolute right-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-sm">
            <Check className="h-3 w-3" />
          </div>
        )}
      </div>

      {/* Preset name */}
      <span
        className={cn(
          'truncate text-center text-xs font-medium leading-none',
          isActive ? 'text-primary' : 'text-muted-foreground group-hover:text-foreground'
        )}
      >
        {preset.name}
      </span>
    </button>
  )
}

export function SettingsAppearance(): React.JSX.Element {
  const themeId = useThemeStore((s) => s.themeId)
  const setTheme = useThemeStore((s) => s.setTheme)
  const previewTheme = useThemeStore((s) => s.previewTheme)
  const cancelPreview = useThemeStore((s) => s.cancelPreview)

  const darkPresets = THEME_PRESETS.filter((p) => p.type === 'dark')
  const lightPresets = THEME_PRESETS.filter((p) => p.type === 'light')

  return (
    <div className="space-y-6" data-testid="settings-appearance">
      <div>
        <h3 className="text-base font-medium mb-1">Appearance</h3>
        <p className="text-sm text-muted-foreground">
          Choose a theme preset. Hover to preview before selecting.
        </p>
      </div>

      <BrandingSection />

      {/* Dark themes */}
      <section className="space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Dark Themes
        </h3>
        <div className="grid grid-cols-3 gap-3" data-testid="dark-themes-grid">
          {darkPresets.map((preset) => (
            <ThemeCard
              key={preset.id}
              preset={preset}
              isActive={themeId === preset.id}
              onSelect={setTheme}
              onMouseEnter={previewTheme}
              onMouseLeave={cancelPreview}
            />
          ))}
        </div>
      </section>

      {/* Light themes */}
      <section className="space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Light Themes
        </h3>
        <div className="grid grid-cols-3 gap-3" data-testid="light-themes-grid">
          {lightPresets.map((preset) => (
            <ThemeCard
              key={preset.id}
              preset={preset}
              isActive={themeId === preset.id}
              onSelect={setTheme}
              onMouseEnter={previewTheme}
              onMouseLeave={cancelPreview}
            />
          ))}
        </div>
      </section>
    </div>
  )
}
