param([string]$BaseUrl = 'http://127.0.0.1:3031')

$ErrorActionPreference = 'Stop'
$suffix = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()

function Get-CsrfToken([string]$html) {
    $match = [regex]::Match($html, 'name="_csrf" value="([^"]+)"')
    if (-not $match.Success) { throw 'CSRF token was not found' }
    return $match.Groups[1].Value
}

$supplierSession = New-Object Microsoft.PowerShell.Commands.WebRequestSession
$registerSupplier = Invoke-WebRequest -Uri "$BaseUrl/register?role=supplier" -WebSession $supplierSession -UseBasicParsing
$supplierCsrf = Get-CsrfToken $registerSupplier.Content
$supplierName = "E2E Пасека $suffix"
$supplierRegisterBody = @{
    _csrf = $supplierCsrf
    role = 'supplier'
    next = '/dashboard'
    display_name = 'Тестовый пасечник'
    company_name = $supplierName
    city_code = 'birsk'
    email = "supplier-$suffix@example.test"
    password = 'Local-test-2026!'
}
$supplierDashboard = Invoke-WebRequest -Uri "$BaseUrl/register" -Method Post -Body $supplierRegisterBody -WebSession $supplierSession -UseBasicParsing
if ($supplierDashboard.Content -notmatch 'Кабинет поставщика') { throw 'Supplier registration did not open the dashboard' }

$supplierCsrf = Get-CsrfToken $supplierDashboard.Content
$profileBody = @{
    _csrf = $supplierCsrf
    name = $supplierName
    story = 'Автоматически созданная тестовая пасека для проверки полного сценария.'
    city_code = 'birsk'
    location_detail = 'Бирский район'
    years_experience = '8'
    hives_count = '120'
    production_type = 'Семейная пасека'
    delivery = 'Доставка от 100 кг'
    certifications = 'Тестовый паспорт пасеки'
    lab_verified = '1'
    frame_available = '1'
    published = '1'
}
$null = Invoke-WebRequest -Uri "$BaseUrl/dashboard/profile" -Method Post -Body $profileBody -WebSession $supplierSession -UseBasicParsing

$lotBody = @{
    _csrf = $supplierCsrf
    variety = 'E2E липовый'
    form = 'Мёд в таре'
    harvest_year = '2026'
    stock_kg = '640'
    min_order_kg = '50'
    price_per_kg = '590'
    packaging = 'Куботейнер 23 кг'
    quality_note = 'Тестовая партия полного сценария'
}
$null = Invoke-WebRequest -Uri "$BaseUrl/dashboard/lots" -Method Post -Body $lotBody -WebSession $supplierSession -UseBasicParsing

$slug = "e2e-paseka-$suffix"
$supplierPage = Invoke-WebRequest -Uri "$BaseUrl/suppliers/$slug" -WebSession $supplierSession -UseBasicParsing
if ($supplierPage.Content -notmatch 'E2E липовый') { throw 'Published lot was not found on supplier page' }
$apiaryId = [regex]::Match($supplierPage.Content, 'name="apiary_id" value="(\d+)"').Groups[1].Value
if (-not $apiaryId) {
    $catalog = Invoke-WebRequest -Uri "$BaseUrl/catalog?q=E2E" -WebSession $supplierSession -UseBasicParsing
    if ($catalog.Content -notmatch [regex]::Escape($supplierName)) { throw 'Published supplier was not found in catalog' }
}

$buyerSession = New-Object Microsoft.PowerShell.Commands.WebRequestSession
$registerBuyer = Invoke-WebRequest -Uri "$BaseUrl/register?role=buyer" -WebSession $buyerSession -UseBasicParsing
$buyerCsrf = Get-CsrfToken $registerBuyer.Content
$buyerRegisterBody = @{
    _csrf = $buyerCsrf
    role = 'buyer'
    next = '/dashboard'
    display_name = 'Тестовый закупщик'
    company_name = "E2E Магазин $suffix"
    city_code = 'ufa'
    email = "buyer-$suffix@example.test"
    password = 'Local-test-2026!'
}
$buyerDashboard = Invoke-WebRequest -Uri "$BaseUrl/register" -Method Post -Body $buyerRegisterBody -WebSession $buyerSession -UseBasicParsing
if ($buyerDashboard.Content -notmatch 'Кабинет закупщика') { throw 'Buyer registration did not open the dashboard' }

$buyerSupplierPage = Invoke-WebRequest -Uri "$BaseUrl/suppliers/$slug" -WebSession $buyerSession -UseBasicParsing
$buyerCsrf = Get-CsrfToken $buyerSupplierPage.Content
$apiaryId = [regex]::Match($buyerSupplierPage.Content, 'name="apiary_id" value="(\d+)"').Groups[1].Value
$lotId = [regex]::Match($buyerSupplierPage.Content, '<option value="(\d+)">E2E липовый').Groups[1].Value
if (-not $apiaryId -or -not $lotId) { throw 'Inquiry form does not contain supplier or lot identifiers' }

$inquiryBody = @{
    _csrf = $buyerCsrf
    apiary_id = $apiaryId
    lot_id = $lotId
    volume_kg = '300'
    delivery_city = 'Уфа'
    message = "E2E заявка $suffix"
}
$buyerAfterInquiry = Invoke-WebRequest -Uri "$BaseUrl/inquiries" -Method Post -Body $inquiryBody -WebSession $buyerSession -UseBasicParsing
if ($buyerAfterInquiry.Content -notmatch $supplierName -or $buyerAfterInquiry.Content -notmatch '300 кг') { throw 'Buyer dashboard does not contain the sent inquiry' }

$supplierAfterInquiry = Invoke-WebRequest -Uri "$BaseUrl/dashboard" -WebSession $supplierSession -UseBasicParsing
if ($supplierAfterInquiry.Content -notmatch "E2E Магазин $suffix" -or $supplierAfterInquiry.Content -notmatch "E2E заявка $suffix") { throw 'Supplier dashboard does not contain the incoming inquiry' }

Write-Output "E2E_OK supplier=$slug apiary_id=$apiaryId lot_id=$lotId"
