# Converte a planilha antiga (xlsx, layout "Registro de Combustível | Manutenções | Impostos/Seguro")
# em migracao.local.js para importar uma vez na Planilha Google.
# Uso: .\exportar-xlsx.ps1 -Caminho "C:\caminho\Despesas carro 2026.xlsx"
# O arquivo gerado contém dados pessoais e está no .gitignore.
param([Parameter(Mandatory)][string]$Caminho)

$inv = [Globalization.CultureInfo]::InvariantCulture
function Num($v) { if ($v -is [double]) { $v } else { $null } }
function Js($v) {
    if ($null -eq $v) { return "''" }
    if ($v -is [datetime]) { return "new Date($($v.Year),$($v.Month - 1),$($v.Day))" }
    if ($v -is [double] -or $v -is [int]) { return ([double]$v).ToString($inv) }
    return "'" + ($v -replace "\\", "\\\\" -replace "'", "\'") + "'"
}

$xl = New-Object -ComObject Excel.Application
$xl.Visible = $false
try {
    $wb = $xl.Workbooks.Open((Resolve-Path $Caminho).Path, 0, $true)
    $sh = $wb.Sheets.Item(1)
    $ultima = $sh.UsedRange.Rows.Count
    $cel = { param($r, $c) $sh.Cells.Item($r, $c).Value2 }
    $data = { param($v)
        if ($v -is [double]) { return [datetime]::FromOADate($v).Date }
        $p = [datetime]::MinValue  # datas digitadas como texto
        if ([datetime]::TryParseExact([string]$v, @('d/M/yyyy', 'dd/MM/yyyy'), $inv, 0, [ref]$p)) { return $p }
        $null }

    $combustivel = @(); $outros = @()
    for ($r = 3; $r -le $ultima; $r++) {
        # Combustível: D data, E litros, F custo, G km, H tipo
        $d = & $data (& $cel $r 4); $custo = Num (& $cel $r 6)
        if ($d -and $custo) {
            $combustivel += [pscustomobject]@{ Data = $d; Litros = Num (& $cel $r 5); Custo = $custo
                Km = Num (& $cel $r 7); Tipo = [string](& $cel $r 8) }
        }
        # Manutenções: M data, N item, O custo, P km
        $d = & $data (& $cel $r 13); $custo = Num (& $cel $r 15)
        if ($d -and $custo) {
            $outros += , @($d, 'Manutenção', $custo, $null, (Num (& $cel $r 16)), $null, $null, $null, $null, [string](& $cel $r 14))
        }
        # Impostos/Seguro: S data, T item, U custo
        $d = & $data (& $cel $r 19); $custo = Num (& $cel $r 21)
        if ($d -and $custo) {
            $item = [string](& $cel $r 20)
            $cat = if ($item -match 'seguro') { 'Seguro' } else { 'Imposto' }
            $outros += , @($d, $cat, $custo, $null, $null, $null, $null, $null, $null, $item)
        }
    }
    $wb.Close($false)
} finally {
    $xl.Quit()
    [void][Runtime.InteropServices.Marshal]::ReleaseComObject($xl)
}

# Km/L só quando este abastecimento e o anterior têm km (senão o intervalo mistura litros).
$linhas = @(); $kmAnt = $null
foreach ($c in ($combustivel | Sort-Object Data)) {
    $rsl = if ($c.Litros) { [math]::Round($c.Custo / $c.Litros, 2) } else { $null }
    $kml = if ($c.Km -and $kmAnt -and $c.Litros -and $c.Km -gt $kmAnt) { [math]::Round(($c.Km - $kmAnt) / $c.Litros, 2) } else { $null }
    $tipo = if ($c.Tipo -match '^[AC]$') { $c.Tipo } else { $null }
    $linhas += , @($c.Data, 'Combustível', $c.Custo, $c.Litros, $c.Km, $tipo, $rsl, $kml, $null, $null)
    $kmAnt = $c.Km
}
$linhas += $outros
$linhas = $linhas | Sort-Object { $_[0] }

$js = "// GERADO por exportar-xlsx.ps1 — dados pessoais, não versionar.`n"
$js += "const MIGRACAO = [`n" + (($linhas | ForEach-Object { "  [" + (($_ | ForEach-Object { Js $_ }) -join ', ') + "]" }) -join ",`n") + "`n];`n`n"
$js += @'
/** Rodar uma vez no editor, numa planilha vazia (depois de configurarPlanilha). */
function migrar() {
  const sh = aba();
  if (sh.getLastRow() > 1) throw new Error('A aba já tem lançamentos; migração cancelada.');
  sh.getRange(2, 1, MIGRACAO.length, COLUNAS.length).setValues(MIGRACAO);
  console.log(MIGRACAO.length + ' linhas migradas');
}
'@
$saida = Join-Path $PSScriptRoot 'migracao.local.js'
[IO.File]::WriteAllText($saida, $js, (New-Object Text.UTF8Encoding $false))
"$($linhas.Count) linhas ($($combustivel.Count) abastecimentos, $($outros.Count) outras) -> $saida"
