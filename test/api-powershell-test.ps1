# README-用法.txt 里教别的应用怎么连管道的那段，逐字拿来跑：
# 判据是「ping 和 text 都回一行 JSON 且 ok=true」，不是「脚本没抛异常」。
$ErrorActionPreference = 'Stop'
$c = New-Object System.IO.Pipes.NamedPipeClientStream('.', 'win-island', 'InOut')
$c.Connect(3000)
$w = New-Object System.IO.StreamWriter($c); $w.AutoFlush = $true
$r = New-Object System.IO.StreamReader($c)

$w.WriteLine('{"cmd":"ping"}')
$p = $r.ReadLine()
"ping -> $p"

$w.WriteLine('{"cmd":"list","limit":3}')
$l = $r.ReadLine()
"list -> " + $l.Substring(0, [Math]::Min(160, $l.Length))

$id = ($l | ConvertFrom-Json).items[0].id
"取第一条 id=$id"
$w.WriteLine('{"cmd":"text","id":"' + $id + '"}')
$t = ($r.ReadLine() | ConvertFrom-Json)
"text -> ok=$($t.ok) 字数=$($t.text.Length) 行数=$(($t.text -split "`r`n").Count)"
$t.text

$w.WriteLine('{"cmd":"copy","id":"' + $id + '"}')
"copy -> " + $r.ReadLine()
"C# 读回剪贴板：[" + (Get-Clipboard -Raw) + "]"

$w.WriteLine('{"cmd":"不存在的命令"}')
"错误分支 -> " + $r.ReadLine()
