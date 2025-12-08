// Script para probar lectura de datos reales de DynamoDB
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, ScanCommand, QueryCommand } = require('@aws-sdk/lib-dynamodb');

async function testRealData() {
  console.log('🔍 Probando lectura de datos reales de DynamoDB...\n');
  
  // Configuración similar a la del módulo
  const region = process.env.AWS_REGION || 'us-east-1';
  const endpoint = process.env.AWS_ENDPOINT_URL;
  
  const config = {
    region,
  };
  
  // Solo usar LocalStack si hay endpoint URL explícitamente configurado
  if (endpoint && endpoint.includes('localhost:4566')) {
    console.log('📍 Usando LocalStack:', endpoint);
    config.endpoint = endpoint;
    config.credentials = {
      accessKeyId: 'test',
      secretAccessKey: 'test',
    };
  } else {
    console.log('📍 Usando AWS Real (region:', region + ')');
    // Usar credenciales de variables de entorno o IAM role
    if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
      config.credentials = {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      };
    }
    // Si no hay credenciales en env, usar IAM role por defecto
  }
  
  const client = new DynamoDBClient(config);
  const docClient = DynamoDBDocumentClient.from(client);
  
  const tables = [
    { name: 'Events-v2', key: 'id' },
    { name: 'Tickets-v2', key: 'id' },
    { name: 'Sales-v2', key: 'id' },
    { name: 'Users-v2', key: 'id' },
    { name: 'Batches-v2', key: 'eventId', rangeKey: 'batchId' },
    { name: 'TicketScans-v2', key: 'id' },
  ];
  
  console.log('📊 Leyendo datos de las tablas...\n');
  
  for (const table of tables) {
    try {
      let result;
      
      if (table.rangeKey) {
        // Para tablas con range key, hacer un scan
        result = await docClient.send(
          new ScanCommand({
            TableName: table.name,
            Limit: 5, // Limitar a 5 items para no sobrecargar
          })
        );
      } else {
        result = await docClient.send(
          new ScanCommand({
            TableName: table.name,
            Limit: 5,
          })
        );
      }
      
      const count = result.Count || 0;
      const items = result.Items || [];
      
      if (count > 0) {
        console.log(`✅ ${table.name}:`);
        console.log(`   📦 Items encontrados: ${count}`);
        console.log(`   📄 Primeros items:`);
        items.slice(0, 3).forEach((item, idx) => {
          console.log(`      ${idx + 1}. ${JSON.stringify(item, null, 2).substring(0, 200)}...`);
        });
        console.log('');
      } else {
        console.log(`ℹ️  ${table.name}: Tabla vacía (0 items)`);
      }
      
    } catch (error) {
      console.error(`❌ ${table.name}:`);
      console.error(`   Error: ${error.message}`);
      console.error(`   Code: ${error.$metadata?.httpStatusCode || 'N/A'}\n`);
    }
  }
  
  // Prueba específica: Intentar obtener eventos con más detalle
  console.log('\n📋 Prueba detallada: Events-v2\n');
  try {
    const eventsResult = await docClient.send(
      new ScanCommand({
        TableName: 'Events-v2',
        Limit: 10,
      })
    );
    
    if (eventsResult.Items && eventsResult.Items.length > 0) {
      console.log(`✅ Se encontraron ${eventsResult.Items.length} eventos:`);
      eventsResult.Items.forEach((event, idx) => {
        console.log(`\n   Evento ${idx + 1}:`);
        console.log(`   - ID: ${event.id}`);
        console.log(`   - Nombre: ${event.name || 'N/A'}`);
        console.log(`   - Fecha: ${event.date || 'N/A'}`);
        console.log(`   - Estado: ${event.status || 'N/A'}`);
      });
    } else {
      console.log('ℹ️  No hay eventos en la base de datos');
    }
  } catch (error) {
    console.error(`❌ Error al leer eventos: ${error.message}`);
  }
  
  console.log('\n✅ Prueba completada!');
}

testRealData().catch(console.error);

