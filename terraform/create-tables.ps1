# Script para crear solo las tablas de DynamoDB
Set-Location $PSScriptRoot

Write-Host "📊 Creando tablas de DynamoDB..." -ForegroundColor Cyan

terraform apply -target=aws_dynamodb_table.events_table `
                -target=aws_dynamodb_table.tickets_table `
                -target=aws_dynamodb_table.sales_table `
                -target=aws_dynamodb_table.users_table `
                -target=aws_dynamodb_table.batches_table `
                -target=aws_dynamodb_table.ticket_scans_table `
                -auto-approve

if ($LASTEXITCODE -eq 0) {
    Write-Host "`n✅ Tablas creadas exitosamente!" -ForegroundColor Green
} else {
    Write-Host "`nError al crear las tablas" -ForegroundColor Red
    exit 1
}

