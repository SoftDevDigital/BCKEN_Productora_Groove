# S3 Bucket para QR y comprobantes
resource "aws_s3_bucket" "ticket_bucket" {
  bucket = "ticket-qr-bucket-dev-v2"
  tags = {
    Environment = "dev"
  }
}

# Versionado del bucket S3
resource "aws_s3_bucket_versioning" "ticket_bucket_versioning" {
  bucket = aws_s3_bucket.ticket_bucket.id
  versioning_configuration {
    status = "Enabled"
  }
}

# Política de acceso público para QRs
resource "aws_s3_bucket_policy" "ticket_bucket_policy" {
  bucket = aws_s3_bucket.ticket_bucket.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Principal = "*"
        Action = "s3:GetObject"
        Resource = "${aws_s3_bucket.ticket_bucket.arn}/qrs/*"
      },
      {
        Effect = "Allow"
        Principal = "*"
        Action = "s3:GetObject"
        Resource = "${aws_s3_bucket.ticket_bucket.arn}/events/*"
      }
    ]
  })
}

# Desactivar Block Public Access para permitir la política
resource "aws_s3_bucket_public_access_block" "ticket_bucket_public_access" {
  bucket = aws_s3_bucket.ticket_bucket.id
  block_public_acls = false
  block_public_policy = false
  ignore_public_acls = false
  restrict_public_buckets = false
}

# Lifecycle para eliminar QRs no pagados después de 7 días
resource "aws_s3_bucket_lifecycle_configuration" "ticket_bucket_lifecycle" {
  bucket = aws_s3_bucket.ticket_bucket.id
  rule {
    id = "DeleteUnpaidQRs"
    status = "Enabled"
    filter {
      prefix = "qrs/"
    }
    expiration {
      days = 7
    }
  }
  rule {
    id = "DeleteEventImages"
    status = "Enabled"
    filter {
      prefix = "events/"
    }
    expiration {
      days = 30
    }
  }
}

# DynamoDB tablas
resource "aws_dynamodb_table" "tickets_table" {
  name = "Tickets-v2"
  billing_mode = "PAY_PER_REQUEST"
  hash_key = "id"
  attribute {
    name = "id"
    type = "S"
  }
}

resource "aws_dynamodb_table" "ticket_scans_table" {
  name = "TicketScans-v2"
  billing_mode = "PAY_PER_REQUEST"
  hash_key = "id"
  attribute {
    name = "id"
    type = "S"
  }
}

resource "aws_dynamodb_table" "users_table" {
  name = "Users-v2"
  billing_mode = "PAY_PER_REQUEST"
  hash_key = "id"
  attribute {
    name = "id"
    type = "S"
  }
  attribute {
    name = "email"
    type = "S"
  }
  attribute {
    name = "alias"
    type = "S"
  }
  global_secondary_index {
    name = "EmailIndex"
    hash_key = "email"
    projection_type = "ALL"
  }
  global_secondary_index {
    name = "AliasIndex"
    hash_key = "alias"
    projection_type = "ALL"
  }
}

resource "aws_dynamodb_table" "sales_table" {
  name = "Sales-v2"
  billing_mode = "PAY_PER_REQUEST"
  hash_key = "id"
  attribute {
    name = "id"
    type = "S"
  }
}

resource "aws_dynamodb_table" "events_table" {
  name = "Events-v2"
  billing_mode = "PAY_PER_REQUEST"
  hash_key = "id"
  attribute {
    name = "id"
    type = "S"
  }
}

resource "aws_dynamodb_table" "batches_table" {
  name = "Batches-v2"
  billing_mode = "PAY_PER_REQUEST"
  hash_key = "eventId"
  range_key = "batchId"
  attribute {
    name = "eventId"
    type = "S"
  }
  attribute {
    name = "batchId"
    type = "S"
  }
}

# SES Email Identity
resource "aws_ses_email_identity" "ticket_email" {
  email = "alexis@laikad.com"
}

# Cognito
resource "aws_cognito_user_pool" "ticket_user_pool" {
  name = "ticket-user-pool"
  username_attributes = ["email"]
  auto_verified_attributes = ["email"]
  password_policy {
    minimum_length = 6
    require_numbers = false
    require_symbols = false
    require_uppercase = false
  }
  schema {
    attribute_data_type = "String"
    name = "email"
    required = true
    mutable = true
    string_attribute_constraints {}
  }
  schema {
    attribute_data_type = "String"
    name = "role"
    required = false
    mutable = true
    string_attribute_constraints {}
  }
  schema {
    attribute_data_type = "String"
    name = "country"
    required = false
    mutable = true
    string_attribute_constraints {}
  }
  mfa_configuration = "OFF"
  email_configuration {
    email_sending_account = "COGNITO_DEFAULT"
  }
  lifecycle {
    ignore_changes = [schema]
  }
}

resource "aws_cognito_user_pool_client" "ticket_app_client" {
  name = "ticket-app-client"
  user_pool_id = aws_cognito_user_pool.ticket_user_pool.id
  generate_secret = true
  explicit_auth_flows = [
    "ALLOW_USER_PASSWORD_AUTH",
    "ALLOW_REFRESH_TOKEN_AUTH"
  ]
  callback_urls = ["http://localhost:3001/callback"]
  logout_urls = ["http://localhost:3001/logout"]
  supported_identity_providers = ["COGNITO"]
  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_flows = ["code"]
  allowed_oauth_scopes = ["email", "openid", "profile"]
  prevent_user_existence_errors = "ENABLED"
}

# API Gateway
resource "aws_apigatewayv2_api" "ticket_api" {
  name = "ticket-api-dev"
  protocol_type = "HTTP"
}

resource "aws_apigatewayv2_authorizer" "cognito_authorizer" {
  api_id = aws_apigatewayv2_api.ticket_api.id
  authorizer_type = "JWT"
  identity_sources = ["$request.header.Authorization"]
  name = "cognito-authorizer"
  jwt_configuration {
    audience = [aws_cognito_user_pool_client.ticket_app_client.id]
    issuer = "https://cognito-idp.us-east-1.amazonaws.com/${aws_cognito_user_pool.ticket_user_pool.id}"
  }
}

# IAM Role for Lambda
resource "aws_iam_role" "lambda_role" {
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action = "sts:AssumeRole"
      Principal = {
        Service = "lambda.amazonaws.com"
      }
      Effect = "Allow"
    }]
  })
}

# Policy for Lambda
resource "aws_iam_policy" "lambda_policy" {
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "cognito-idp:*",
          "s3:PutObject",
          "s3:GetObject",
          "dynamodb:*",
          "ses:SendEmail",
          "sns:*",
          "logs:*"
        ]
        Resource = "*"
      }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "lambda_basic" {
  role = aws_iam_role.lambda_role.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy_attachment" "lambda_custom" {
  role = aws_iam_role.lambda_role.name
  policy_arn = aws_iam_policy.lambda_policy.arn
}

# Lambda Function
resource "aws_lambda_function" "ticket_backend" {
  function_name = "ticket-backend-dev"
  role = aws_iam_role.lambda_role.arn
  handler = "main.handler"
  runtime = "nodejs20.x"
  filename = data.archive_file.lambda_zip.output_path
  source_code_hash = data.archive_file.lambda_zip.output_base64sha256
  timeout = 30
  memory_size = 512
  environment {
    variables = {
      COGNITO_USER_POOL_ID = aws_cognito_user_pool.ticket_user_pool.id
      COGNITO_CLIENT_ID = aws_cognito_user_pool_client.ticket_app_client.id
      COGNITO_CLIENT_SECRET = aws_cognito_user_pool_client.ticket_app_client.client_secret
      MERCADO_PAGO_ACCESS_TOKEN = "APP_USR-8581189409054279-091018-c6d03928f1a9466fb3fbc1cdbcf80512-2369426390"
      API_BASE_URL = "http://localhost:3001"
      S3_BUCKET = aws_s3_bucket.ticket_bucket.bucket
      SES_EMAIL = "alexis@laikad.com"
    }
  }
}

# Zip
data "archive_file" "lambda_zip" {
  type = "zip"
  source_dir = "${path.module}/../dist"
  output_path = "lambda.zip"
}

resource "aws_lambda_permission" "apigw_lambda" {
  statement_id = "AllowExecutionFromAPIGateway"
  action = "lambda:InvokeFunction"
  function_name = aws_lambda_function.ticket_backend.function_name
  principal = "apigateway.amazonaws.com"
  source_arn = "${aws_apigatewayv2_api.ticket_api.execution_arn}/*/*"
}

resource "aws_apigatewayv2_integration" "lambda_integration" {
  api_id = aws_apigatewayv2_api.ticket_api.id
  integration_type = "AWS_PROXY"
  integration_uri = aws_lambda_function.ticket_backend.invoke_arn
}

resource "aws_apigatewayv2_stage" "default" {
  api_id = aws_apigatewayv2_api.ticket_api.id
  name = "$default"
  auto_deploy = true
}

# Rutas
resource "aws_apigatewayv2_route" "auth_signup" {
  api_id = aws_apigatewayv2_api.ticket_api.id
  route_key = "POST /auth/signup"
  target = "integrations/${aws_apigatewayv2_integration.lambda_integration.id}"
}

resource "aws_apigatewayv2_route" "auth_signin" {
  api_id = aws_apigatewayv2_api.ticket_api.id
  route_key = "POST /auth/signin"
  target = "integrations/${aws_apigatewayv2_integration.lambda_integration.id}"
}

resource "aws_apigatewayv2_route" "auth_confirm" {
  api_id = aws_apigatewayv2_api.ticket_api.id
  route_key = "POST /auth/confirm"
  target = "integrations/${aws_apigatewayv2_integration.lambda_integration.id}"
}

resource "aws_apigatewayv2_route" "auth_resend" {
  api_id = aws_apigatewayv2_api.ticket_api.id
  route_key = "POST /auth/resend-confirmation"
  target = "integrations/${aws_apigatewayv2_integration.lambda_integration.id}"
}

resource "aws_apigatewayv2_route" "auth_admin_assign_role" {
  api_id = aws_apigatewayv2_api.ticket_api.id
  route_key = "POST /auth/admin/assign-role"
  target = "integrations/${aws_apigatewayv2_integration.lambda_integration.id}"
  authorization_type = "JWT"
  authorizer_id = aws_apigatewayv2_authorizer.cognito_authorizer.id
}

resource "aws_apigatewayv2_route" "auth_admin_confirm" {
  api_id = aws_apigatewayv2_api.ticket_api.id
  route_key = "POST /auth/admin/confirm-signup"
  target = "integrations/${aws_apigatewayv2_integration.lambda_integration.id}"
  authorization_type = "JWT"
  authorizer_id = aws_apigatewayv2_authorizer.cognito_authorizer.id
}

resource "aws_apigatewayv2_route" "events_list" {
  api_id = aws_apigatewayv2_api.ticket_api.id
  route_key = "GET /events"
  target = "integrations/${aws_apigatewayv2_integration.lambda_integration.id}"
}

resource "aws_apigatewayv2_route" "events_get" {
  api_id = aws_apigatewayv2_api.ticket_api.id
  route_key = "GET /events/{id}"
  target = "integrations/${aws_apigatewayv2_integration.lambda_integration.id}"
}

resource "aws_apigatewayv2_route" "events_create" {
  api_id = aws_apigatewayv2_api.ticket_api.id
  route_key = "POST /events"
  target = "integrations/${aws_apigatewayv2_integration.lambda_integration.id}"
  authorization_type = "JWT"
  authorizer_id = aws_apigatewayv2_authorizer.cognito_authorizer.id
}

resource "aws_apigatewayv2_route" "events_update" {
  api_id = aws_apigatewayv2_api.ticket_api.id
  route_key = "PUT /events/{id}"
  target = "integrations/${aws_apigatewayv2_integration.lambda_integration.id}"
  authorization_type = "JWT"
  authorizer_id = aws_apigatewayv2_authorizer.cognito_authorizer.id
}

resource "aws_apigatewayv2_route" "events_delete" {
  api_id = aws_apigatewayv2_api.ticket_api.id
  route_key = "DELETE /events/{id}"
  target = "integrations/${aws_apigatewayv2_integration.lambda_integration.id}"
  authorization_type = "JWT"
  authorizer_id = aws_apigatewayv2_authorizer.cognito_authorizer.id
}

resource "aws_apigatewayv2_route" "events_search" {
  api_id = aws_apigatewayv2_api.ticket_api.id
  route_key = "GET /events/search"
  target = "integrations/${aws_apigatewayv2_integration.lambda_integration.id}"
}

resource "aws_apigatewayv2_route" "batches_create" {
  api_id = aws_apigatewayv2_api.ticket_api.id
  route_key = "POST /events/{id}/batches"
  target = "integrations/${aws_apigatewayv2_integration.lambda_integration.id}"
  authorization_type = "JWT"
  authorizer_id = aws_apigatewayv2_authorizer.cognito_authorizer.id
}

resource "aws_apigatewayv2_route" "batches_list" {
  api_id = aws_apigatewayv2_api.ticket_api.id
  route_key = "GET /events/{id}/batches"
  target = "integrations/${aws_apigatewayv2_integration.lambda_integration.id}"
  authorization_type = "JWT"
  authorizer_id = aws_apigatewayv2_authorizer.cognito_authorizer.id
}

resource "aws_apigatewayv2_route" "batches_update" {
  api_id = aws_apigatewayv2_api.ticket_api.id
  route_key = "PUT /events/{id}/batches/{batchId}"
  target = "integrations/${aws_apigatewayv2_integration.lambda_integration.id}"
  authorization_type = "JWT"
  authorizer_id = aws_apigatewayv2_authorizer.cognito_authorizer.id
}

resource "aws_apigatewayv2_route" "batches_delete" {
  api_id = aws_apigatewayv2_api.ticket_api.id
  route_key = "DELETE /events/{id}/batches/{batchId}"
  target = "integrations/${aws_apigatewayv2_integration.lambda_integration.id}"
  authorization_type = "JWT"
  authorizer_id = aws_apigatewayv2_authorizer.cognito_authorizer.id
}

resource "aws_apigatewayv2_route" "sales_direct" {
  api_id = aws_apigatewayv2_api.ticket_api.id
  route_key = "POST /sales"
  target = "integrations/${aws_apigatewayv2_integration.lambda_integration.id}"
  authorization_type = "JWT"
  authorizer_id = aws_apigatewayv2_authorizer.cognito_authorizer.id
}

resource "aws_apigatewayv2_route" "sales_reseller" {
  api_id = aws_apigatewayv2_api.ticket_api.id
  route_key = "POST /sales/reseller"
  target = "integrations/${aws_apigatewayv2_integration.lambda_integration.id}"
  authorization_type = "JWT"
  authorizer_id = aws_apigatewayv2_authorizer.cognito_authorizer.id
}

resource "aws_apigatewayv2_route" "sales_reseller_generate_payment" {
  api_id = aws_apigatewayv2_api.ticket_api.id
  route_key = "POST /sales/reseller/generate-payment"
  target = "integrations/${aws_apigatewayv2_integration.lambda_integration.id}"
  authorization_type = "JWT"
  authorizer_id = aws_apigatewayv2_authorizer.cognito_authorizer.id
}

resource "aws_apigatewayv2_route" "sales_webhook" {
  api_id = aws_apigatewayv2_api.ticket_api.id
  route_key = "POST /sales/webhook"
  target = "integrations/${aws_apigatewayv2_integration.lambda_integration.id}"
}

resource "aws_apigatewayv2_route" "payments_success" {
  api_id = aws_apigatewayv2_api.ticket_api.id
  route_key = "GET /payments/success"
  target = "integrations/${aws_apigatewayv2_integration.lambda_integration.id}"
}

resource "aws_apigatewayv2_route" "payments_failure" {
  api_id = aws_apigatewayv2_api.ticket_api.id
  route_key = "GET /payments/failure"
  target = "integrations/${aws_apigatewayv2_integration.lambda_integration.id}"
}

resource "aws_apigatewayv2_route" "payments_pending" {
  api_id = aws_apigatewayv2_api.ticket_api.id
  route_key = "GET /payments/pending"
  target = "integrations/${aws_apigatewayv2_integration.lambda_integration.id}"
}

resource "aws_apigatewayv2_route" "tickets_validate" {
  api_id = aws_apigatewayv2_api.ticket_api.id
  route_key = "GET /tickets/validate/{ticketId}"
  target = "integrations/${aws_apigatewayv2_integration.lambda_integration.id}"
  authorization_type = "JWT"
  authorizer_id = aws_apigatewayv2_authorizer.cognito_authorizer.id
}

resource "aws_apigatewayv2_route" "user_profile" {
  api_id = aws_apigatewayv2_api.ticket_api.id
  route_key = "GET /user/profile"
  target = "integrations/${aws_apigatewayv2_integration.lambda_integration.id}"
  authorization_type = "JWT"
  authorizer_id = aws_apigatewayv2_authorizer.cognito_authorizer.id
}

resource "aws_apigatewayv2_route" "user_purchases" {
  api_id = aws_apigatewayv2_api.ticket_api.id
  route_key = "GET /user/purchases"
  target = "integrations/${aws_apigatewayv2_integration.lambda_integration.id}"
  authorization_type = "JWT"
  authorizer_id = aws_apigatewayv2_authorizer.cognito_authorizer.id
}

resource "aws_apigatewayv2_route" "admin_users" {
  api_id = aws_apigatewayv2_api.ticket_api.id
  route_key = "GET /admin/users"
  target = "integrations/${aws_apigatewayv2_integration.lambda_integration.id}"
  authorization_type = "JWT"
  authorizer_id = aws_apigatewayv2_authorizer.cognito_authorizer.id
}

resource "aws_apigatewayv2_route" "admin_reports_sales" {
  api_id = aws_apigatewayv2_api.ticket_api.id
  route_key = "GET /admin/reports/sales"
  target = "integrations/${aws_apigatewayv2_integration.lambda_integration.id}"
  authorization_type = "JWT"
  authorizer_id = aws_apigatewayv2_authorizer.cognito_authorizer.id
}

resource "aws_apigatewayv2_route" "admin_reports_sale_details" {
  api_id = aws_apigatewayv2_api.ticket_api.id
  route_key = "GET /admin/reports/sales/{saleId}"
  target = "integrations/${aws_apigatewayv2_integration.lambda_integration.id}"
  authorization_type = "JWT"
  authorizer_id = aws_apigatewayv2_authorizer.cognito_authorizer.id
}

resource "aws_apigatewayv2_route" "admin_reports_users" {
  api_id = aws_apigatewayv2_api.ticket_api.id
  route_key = "GET /admin/reports/users"
  target = "integrations/${aws_apigatewayv2_integration.lambda_integration.id}"
  authorization_type = "JWT"
  authorizer_id = aws_apigatewayv2_authorizer.cognito_authorizer.id
}