# 频谱引擎的自证夹具（test/audio-test.mjs 用）。两种模式：
#   默认            跑完整判据：安静基线 -> 250/440/1000/4000/8000Hz 纯音 -> 每格归零，打一行 JSON
#   -Tone 1000      只放一个纯音（给「活着的岛」那半截用：岛那边同时在读管道和数像素）
#                   -Tone 1000 -HoldMs 3200
#   -Tones 200,500  只放和弦，可门控：-HoldMs 700 -GateMs 700 -Pairs 5 → 明 0.7s / 暗 0.7s 交替五对，
#                   每段开头打一行 "on k" / "off k" 让调用方按段分桶（判据是配对差，不是前后比）
#
# 判据是「已知频率落对格」，不是「柱子在动」：后者放个背景音乐也能过，证明不了频率映射是对的。
# 纯音是这里现生成的正弦 WAV（合成信号，不含任何真实内容），走系统混音，所以 loopback 抓到的是
# 真实播放路径上的声音 —— 抓到 == 屏幕上会响。
# 幅度 0.5（≈ -6dBFS 的单个正弦，够压过一般环境声又不吵）：曾经给到 1.0 满幅，因为测到这台机器
# 正在放视频、低中频那一格自己就到 0.43，0.5 的正弦在「最亮格子」那条上会输给它。
# 现在的取法是：判据一个字不动，输入取到「能盖过环境」和「不吵到人」之间的那一档。
# 单个正弦在 0.5 下峰值 16000/32767，不削波，所以频率映射和线性度还是拿干净信号在测。
#
# 注意：本文件必须存成「UTF-8 带 BOM」。
[CmdletBinding()]
param(
  [int]$Tone = 0,
  [string]$Tones = '',
  [int]$HoldMs = 3000,
  [int]$Bands = 12,
  [double]$Amp = 0.5,
  [int]$StallMs = 150,
  [double]$Gain = 1.0,
  [int]$GateMs = 0,
  [int]$Pairs = 6
)
$ErrorActionPreference = 'Stop'
. (Join-Path (Split-Path $PSScriptRoot -Parent) 'src/island/audio.ps1')

# ---------- 合成纯音 / 和弦 ----------
# 和弦（几个正弦等分幅度相加）是给「屏幕上柱子真的长高」那条判据用的：单频纯音只抬一根柱子，
# 3px 宽 × 十几 px 高 = 几十个像素，和环境声本身的起伏一个量级，测不出名堂；五根柱子一起立起来
# 才是屏幕上看得见、数得清的变化。白噪声反而不行 —— 峰值口径下噪声每根谱线比同幅度正弦低 16 倍
# （N/4 对 sqrt(N) 的处理增益差），要响到削波才看得见，那不是真实音乐的样子。
function New-ToneWav([int[]]$hzes, [double]$amp, [double]$secs) {
  # 22050 而不是 44100：判据最高测到 8kHz，奈奎斯特 11kHz 够了，而 PowerShell 里逐样本算正弦
  # 是这段夹具最慢的地方（9 秒 × 5 个和弦成分在 44.1k 下要跑 45 秒，调用方直接超时）。
  $rate = 22050
  $n = [int]($rate * $secs)
  $buf = New-Object byte[] (44 + $n * 2)
  $buf[0] = 82; $buf[1] = 73; $buf[2] = 70; $buf[3] = 70          # 'RIFF'
  $w32 = { param($b, $o, $v) $b[$o] = $v -band 255; $b[$o + 1] = ($v -shr 8) -band 255; $b[$o + 2] = ($v -shr 16) -band 255; $b[$o + 3] = ($v -shr 24) -band 255 }
  $w16 = { param($b, $o, $v) $b[$o] = $v -band 255; $b[$o + 1] = ($v -shr 8) -band 255 }
  & $w32 $buf 4 (36 + $n * 2)
  $buf[8] = 87; $buf[9] = 65; $buf[10] = 86; $buf[11] = 69        # 'WAVE'
  $buf[12] = 102; $buf[13] = 109; $buf[14] = 116; $buf[15] = 32   # 'fmt '
  & $w32 $buf 16 16; & $w16 $buf 20 1; & $w16 $buf 22 1
  & $w32 $buf 24 $rate; & $w32 $buf 28 ($rate * 2); & $w16 $buf 32 2; & $w16 $buf 34 16
  $buf[36] = 100; $buf[37] = 97; $buf[38] = 116; $buf[39] = 97    # 'data'
  & $w32 $buf 40 ($n * 2)
  # 相位错开 + 峰值归一：几个正弦同相位起手时峰值是 N 倍单音，要让每根柱子都立起来就得把整体
  # 顶到削波（先前就是那样，2.5 的幅度吵到人）。错开相位后同样的峰值下每个成分能给得更响，
  # 最后再按实际最大样本把整段缩放到 $amp —— 所以 $amp 现在是「峰值」而不是「每成分幅度」，不会削波。
  $fade = [int]($rate * 0.01)          # 10ms 淡入淡出：不加的话每个周期边界都是一次咔哒
  $samples = New-Object double[] $n
  $peak = 0.0
  for ($i = 0; $i -lt $n; $i++) {
    $s = 0.0
    for ($j = 0; $j -lt $hzes.Count; $j++) {
      $s += [Math]::Sin(2 * [Math]::PI * $hzes[$j] * $i / $rate + $j * 2.39996)
    }
    $k = 1.0
    if ($i -lt $fade) { $k = $i / $fade }
    if ($i -ge $n - $fade) { $k = ($n - $i) / $fade }
    $s = $s * $k
    $samples[$i] = $s
    $a = [Math]::Abs($s)
    if ($a -gt $peak) { $peak = $a }
  }
  $g = if ($peak -gt 0) { $amp / $peak } else { 0 }      # 归一：整段最大样本正好等于 $amp
  for ($i = 0; $i -lt $n; $i++) {
    $v = [int]($samples[$i] * $g * 32000)
    if ($v -lt -32768) { $v = -32768 }
    if ($v -gt 32767) { $v = 32767 }
    & $w16 $buf (44 + $i * 2) $v
  }
  $f = Join-Path $env:TEMP ("wi-audio-test-{0}.wav" -f ($hzes -join '-'))
  [void][System.IO.File]::WriteAllBytes($f, $buf)
  return $f
}

function Play-Tone([int[]]$hzes, [double]$amp, [double]$secs) {
  $f = New-ToneWav $hzes $amp $secs
  $p = New-Object System.Media.SoundPlayer $f
  $p.Play()                       # 异步：放的这几秒里调用方去采样
  return $p
}

# ---------- 只放音模式（给「活着的岛 + 真实像素」那半截用）----------
# $Tones 收的是逗号串：powershell -File 传参时「200,500,1200」是一个字符串实参，
# 直接绑到 [int[]] 上会报 ParameterArgumentTransformationError（实测炸过一次）。
$hzs = @($Tones.Split(',') | ForEach-Object { [int]$_.Trim() } | Where-Object { $_ -gt 0 })
if ($Tone -gt 0) { $hzs = @($Tone) }
if ($hzs.Count -gt 0) {
  $f = New-ToneWav $hzs $Amp ([double]$HoldMs / 1000.0)
  $p = New-Object System.Media.SoundPlayer $f
  # 「开始放」之前先打这一行：合成几秒音频要一两秒，调用方要是按时间猜，量像素会量在声音还没响的时候。
  [Console]::Out.WriteLine('playing ' + ($hzs -join '+') + ' Hz for ' + $HoldMs + ' ms')
  [Console]::Out.Flush()
  if ($GateMs -gt 0) {
    # 明暗交替放：on 一段、off 一段，成对重复。这样调用方要的不是「放音时比不放音多几个像素」，
    # 而是「每一次 on 都比紧挨着它的 off 多」——环境声（随时在放的视频）和这个门没有相关性，
    # 它进的是两边共同的底，配对差一减就没了。于是激励可以很小声，判据反而更难蒙对。
    for ($k = 1; $k -le $Pairs; $k++) {
      [Console]::Out.WriteLine("on $k"); [Console]::Out.Flush()
      $p.Play()
      Start-Sleep -Milliseconds $HoldMs
      $p.Stop()
      [Console]::Out.WriteLine("off $k"); [Console]::Out.Flush()
      Start-Sleep -Milliseconds $GateMs
    }
    exit 0
  }
  $p.Play()
  Start-Sleep -Milliseconds $HoldMs
  $p.Stop()
  Start-Sleep -Milliseconds 120
  exit 0
}

# ---------- 全判据模式 ----------
$s = Start-IslandAudio $Bands $Gain $StallMs
# Open 不阻塞（岛在 UI 线程上调它），所以夹具这边等它有结论：最多 6 秒
for ($i = 0; $i -lt 60 -and $s -eq 'opening...'; $i++) {
  Start-Sleep -Milliseconds 100
  $s = Get-IslandAudioStatus
}
if ($s -notlike 'ok*') {
  # 这一行是给 node 读的判据，控制台编码会吃掉中文，所以整行 ASCII（原因本身也够短）
  '{"ok":false,"reason":"ENGINE NOT OPEN: ' + ($s -replace '[^\x20-\x7E]', '') + '"}'
  exit 1
}
$edges = Get-IslandAudioBandEdges $Bands

# 每格各自的峰值（不是最后一帧）：环境里另有声音时，「最大」最能代表「纯音压上来之后那格到过哪里」，
# 而起落两条判据都要对着同一个口径比，口径混了判据就没意义。
$edges = Get-IslandAudioBandEdges $Bands
$script:Edges = $edges

function Band-Of([double]$hz) {
  for ($i = 0; $i -lt $script:Edges.Count - 1; $i++) {
    if ($hz -ge $script:Edges[$i] -and $hz -lt $script:Edges[$i + 1]) { return $i }
  }
  return -1
}
function Median($xs) {
  $s = @($xs | Sort-Object)
  if ($s.Count -eq 0) { return 0 }
  return [double]$s[[int][Math]::Floor($s.Count / 2)]
}

function Sample([int]$ms) {
  # 一段采样回四样东西：这一段的最大值、每格各自的最大值、新分析窗数、以及「主峰频率」的统计量。
  # 主峰为什么取「投票 + 中位数」而不是「最响那一帧的峰」：Levels() 是平滑过的，格子最大值所在
  # 帧和当下这一窗不一定对得上，混着取会出现「峰值频率来自安静帧」（实测就被这么坑过一次：
  # 440Hz 那一段报了 23554Hz，因为最响的格子来自环境声的瞬时）。所以：
  #   peakBand  = 这一段里「谱峰落在哪一格」的众数（纯音在时它压倒性多数）
  #   peakHz    = 落在 peakBand 里那些帧的谱峰频率中位数（对着已知频率判 ±2% 用的就是它）
  #   peakShare = 众数那一格占了多少帧（0.6 就意味着六成时间的谱峰在这儿）
  $win0 = [long](Get-IslandAudioSnapshot).windows
  $mx = 0; $top = -1; $everNz = $false
  $end = (Get-Date).AddMilliseconds($ms)
  $n0 = @(Get-IslandAudioLevels).Count
  $bmax = @(0) * $n0
  $votes = @{}; $inBand = @()
  while ((Get-Date) -lt $end) {
    Start-Sleep -Milliseconds 45
    $lv = @(Get-IslandAudioLevels)
    $fr = 0
    for ($i = 0; $i -lt $lv.Count; $i++) {
      if ([double]$lv[$i] -ne 0) { $everNz = $true }
      if ([double]$lv[$i] -gt [double]$bmax[$i]) { $bmax[$i] = [double]$lv[$i] }
      if ([double]$lv[$i] -gt $fr) { $fr = [double]$lv[$i] }
    }
    if ($fr -gt $mx) { $mx = $fr; for ($i = 0; $i -lt $lv.Count; $i++) { if ([double]$lv[$i] -eq $fr) { $top = $i; break } } }
    $pk = [double][IslandAudio]::PeakHz()
    if ($pk -gt 0) {
      $bi = Band-Of $pk
      if ($bi -ge 0) {
        if ($votes.ContainsKey($bi)) { $votes[$bi] = $votes[$bi] + 1 } else { $votes[$bi] = 1 }
        $inBand += , @($bi, $pk)
      }
    }
  }
  $pb = -1; $pn = 0
  foreach ($k in $votes.Keys) { if ($votes[$k] -gt $pn) { $pn = $votes[$k]; $pb = $k } }
  $tot = 0; foreach ($k in $votes.Keys) { $tot += $votes[$k] }
  $pkVals = @($inBand | Where-Object { $_[0] -eq $pb } | ForEach-Object { $_[1] })
  $snap = Get-IslandAudioSnapshot
  return @{
    top = $top
    topv = [Math]::Round([double]$mx, 4)
    max = [Math]::Round([double]$mx, 4)
    peakHz = [Math]::Round((Median $pkVals), 1)
    peakBand = $pb
    peakShare = [Math]::Round($(if ($tot) { $pn / $tot } else { 0 }), 3)
    peakFrames = $pn
    ever = $everNz                          # 这一段里出现过任何一帧非零就是 true
    windows = [long]$snap.windows - $win0
    bandsMax = @($bmax | ForEach-Object { [Math]::Round([double]$_, 4) })
  }
}

$out = @{ ok = $true; status = ($s -replace '"', ''); bandsN = $Bands; stallMs = $StallMs;
  edges = @($edges | ForEach-Object { [Math]::Round([double]$_, 1) }) }
$out['baseline'] = Sample 1200
foreach ($hz in 250, 440, 1000, 4000, 8000) {
  # 每个频率前面各取一小段「不放音」的对照：环境声随视频内容起伏，开跑时那一段基线
  # 不能代表 30 秒后放 440Hz 时的底 —— 对照要贴着激励取，否则比的是两段不同的视频。
  $out["pre$hz"] = Sample 500
  $p = Play-Tone $hz $Amp 4.0
  $out["t$hz"] = Sample 1800
  $p.Stop()
  # 停掉纯音再取一段：这一格必须从「纯音 dominating」掉回去。
  # 掉回 0 只有在整机安静时才成立；环境里有别的声音时它掉回的是那个底，所以判据是「明显回落」。
  Start-Sleep -Milliseconds ($StallMs + 300)
  $out["after$hz"] = Sample 400
}

# ---- 停顿衰减（归零判据里唯一在「背景不安静」下也成立的那条）----
# 纯音正响的时候把抓取停掉：这一刻引擎里还是满的谱，但不会再有新分析窗，
# 柱子必须自己一路压到 0。冻在最后一帧 = 这条判据直接不过。
$pt = Play-Tone 1000 $Amp 3.0
Start-Sleep -Milliseconds 1200
$frozen = @(Get-IslandAudioLevels)
Stop-IslandAudio
Start-Sleep -Milliseconds ($StallMs + 320)
$after = @(Get-IslandAudioLevels)
$pt.Stop()
$out['stall'] = @{
  before = [Math]::Round([double](($frozen | Measure-Object -Maximum).Maximum), 4)
  after = @($after | ForEach-Object { [Math]::Round([double]$_, 4) })
  afterMax = [Math]::Round([double](($after | Measure-Object -Maximum).Maximum), 4)
}
ConvertTo-Json $out -Compress -Depth 6
