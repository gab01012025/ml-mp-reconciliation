/**
 * Excel Export Service
 * Generates Excel files for orders, movements, and reconciliation reports
 */

import ExcelJS from 'exceljs';
import { createLogger } from '../../../config/logger.js';
import { prisma } from '../../../shared/database/client.js';

const logger = createLogger('excel-export');

interface ExportOptions {
  startDate: Date;
  endDate: Date;
}

interface ReconciliationExportOptions extends ExportOptions {
  reconciliationId?: string;
}

class ExcelExportService {
  /**
   * Export ML orders to Excel
   */
  async exportOrders(options: ExportOptions): Promise<Buffer> {
    logger.info({ startDate: options.startDate, endDate: options.endDate }, 'Exporting orders to Excel');

    const orders = await prisma.mLOrder.findMany({
      where: {
        dateCreated: {
          gte: options.startDate,
          lte: options.endDate,
        },
      },
      include: {
        items: true,
        payments: true,
      },
      orderBy: { dateCreated: 'desc' },
    });

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'ML-MP Reconciliation';
    workbook.created = new Date();

    const sheet = workbook.addWorksheet('Pedidos ML', {
      properties: { tabColor: { argb: 'FF00A0DC' } },
    });

    // Define columns
    sheet.columns = [
      { header: 'ID ML', key: 'externalId', width: 15 },
      { header: 'Data', key: 'dateCreated', width: 18 },
      { header: 'Status', key: 'status', width: 15 },
      { header: 'Produtos', key: 'products', width: 40 },
      { header: 'Qtd Itens', key: 'itemCount', width: 12 },
      { header: 'Valor Total', key: 'totalAmount', width: 15 },
      { header: 'Frete', key: 'shippingCost', width: 12 },
      { header: 'Seller ID', key: 'sellerId', width: 15 },
      { header: 'Buyer ID', key: 'buyerId', width: 15 },
    ];

    // Style header row
    const headerRow = sheet.getRow(1);
    headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    headerRow.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF00A0DC' },
    };
    headerRow.alignment = { vertical: 'middle', horizontal: 'center' };

    // Add data
    for (const order of orders) {
      const productTitles = order.items.map(i => i.title).join(', ');
      sheet.addRow({
        externalId: order.externalId,
        dateCreated: order.dateCreated,
        status: order.status,
        products: productTitles.substring(0, 100),
        itemCount: order.items.length,
        totalAmount: Number(order.totalAmount),
        shippingCost: order.shippingCost ? Number(order.shippingCost) : 0,
        sellerId: order.sellerId,
        buyerId: order.buyerId || '',
      });
    }

    // Format currency columns
    ['F', 'G'].forEach(col => {
      sheet.getColumn(col).numFmt = 'R$ #,##0.00';
    });

    // Format date column
    sheet.getColumn('B').numFmt = 'dd/mm/yyyy hh:mm';

    // Add summary at bottom
    sheet.addRow({});
    sheet.addRow({
      externalId: 'TOTAL',
      itemCount: orders.length,
      totalAmount: orders.reduce((sum, o) => sum + Number(o.totalAmount), 0),
      shippingCost: orders.reduce((sum, o) => sum + Number(o.shippingCost || 0), 0),
    });
    const lastRow = sheet.lastRow;
    if (lastRow) {
      lastRow.font = { bold: true };
    }

    const buffer = await workbook.xlsx.writeBuffer();
    logger.info({ orderCount: orders.length }, 'Orders exported to Excel');

    return Buffer.from(buffer);
  }

  /**
   * Export MP movements to Excel
   */
  async exportMovements(options: ExportOptions): Promise<Buffer> {
    logger.info({ startDate: options.startDate, endDate: options.endDate }, 'Exporting movements to Excel');

    const movements = await prisma.mPMovement.findMany({
      where: {
        dateCreated: {
          gte: options.startDate,
          lte: options.endDate,
        },
      },
      orderBy: { dateCreated: 'desc' },
    });

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'ML-MP Reconciliation';
    workbook.created = new Date();

    const sheet = workbook.addWorksheet('Movimentos MP', {
      properties: { tabColor: { argb: 'FF009EE3' } },
    });

    // Define columns
    sheet.columns = [
      { header: 'ID MP', key: 'externalId', width: 15 },
      { header: 'Data', key: 'dateCreated', width: 18 },
      { header: 'Tipo', key: 'type', width: 15 },
      { header: 'Descrição', key: 'description', width: 40 },
      { header: 'Valor', key: 'amount', width: 15 },
      { header: 'Taxa', key: 'fee', width: 12 },
      { header: 'Valor Líquido', key: 'netAmount', width: 15 },
      { header: 'ID Referência', key: 'referenceId', width: 18 },
      { header: 'Status', key: 'status', width: 15 },
    ];

    // Style header row
    const headerRow = sheet.getRow(1);
    headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    headerRow.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF009EE3' },
    };
    headerRow.alignment = { vertical: 'middle', horizontal: 'center' };

    // Add data
    for (const mov of movements) {
      sheet.addRow({
        externalId: mov.externalId,
        dateCreated: mov.dateCreated,
        type: mov.type,
        description: mov.description || '',
        amount: Number(mov.amount),
        fee: mov.fee ? Number(mov.fee) : 0,
        netAmount: mov.netAmount ? Number(mov.netAmount) : Number(mov.amount),
        referenceId: mov.referenceId || '',
        status: mov.status || '',
      });
    }

    // Format currency columns
    ['E', 'F', 'G'].forEach(col => {
      sheet.getColumn(col).numFmt = 'R$ #,##0.00';
    });

    // Format date column
    sheet.getColumn('B').numFmt = 'dd/mm/yyyy hh:mm';

    // Add summary
    sheet.addRow({});
    sheet.addRow({
      externalId: 'TOTAL',
      amount: movements.reduce((sum, m) => sum + Number(m.amount), 0),
      fee: movements.reduce((sum, m) => sum + Number(m.fee || 0), 0),
      netAmount: movements.reduce((sum, m) => sum + Number(m.netAmount || m.amount), 0),
    });
    const lastRow = sheet.lastRow;
    if (lastRow) {
      lastRow.font = { bold: true };
    }

    const buffer = await workbook.xlsx.writeBuffer();
    logger.info({ movementCount: movements.length }, 'Movements exported to Excel');

    return Buffer.from(buffer);
  }

  /**
   * Export reconciliation report to Excel
   */
  async exportReconciliation(options: ReconciliationExportOptions): Promise<Buffer> {
    logger.info(options, 'Exporting reconciliation to Excel');

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'ML-MP Reconciliation';
    workbook.created = new Date();

    // Get reconciliation data
    const whereClause = options.reconciliationId
      ? { id: options.reconciliationId }
      : {
          periodStart: { gte: options.startDate },
          periodEnd: { lte: options.endDate },
        };

    const reconciliations = await prisma.reconciliation.findMany({
      where: whereClause,
      include: {
        items: {
          include: {
            order: {
              include: { items: true },
            },
            movement: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    // Summary sheet
    const summarySheet = workbook.addWorksheet('Resumo', {
      properties: { tabColor: { argb: 'FF4CAF50' } },
    });

    summarySheet.columns = [
      { header: 'ID Conciliação', key: 'id', width: 40 },
      { header: 'Período Início', key: 'periodStart', width: 18 },
      { header: 'Período Fim', key: 'periodEnd', width: 18 },
      { header: 'Total Pedidos', key: 'totalOrders', width: 15 },
      { header: 'Total Movimentos', key: 'totalMovements', width: 18 },
      { header: 'Conciliados', key: 'matchedCount', width: 12 },
      { header: 'Não Encontrados', key: 'unmatchedCount', width: 15 },
      { header: 'Divergentes', key: 'divergentCount', width: 12 },
      { header: 'Receita Esperada', key: 'expectedRevenue', width: 18 },
      { header: 'Receita Real', key: 'actualRevenue', width: 15 },
      { header: 'Discrepância', key: 'discrepancy', width: 15 },
      { header: 'Status', key: 'status', width: 12 },
    ];

    // Style header
    const summaryHeader = summarySheet.getRow(1);
    summaryHeader.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    summaryHeader.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF4CAF50' },
    };

    for (const rec of reconciliations) {
      summarySheet.addRow({
        id: rec.id,
        periodStart: rec.periodStart,
        periodEnd: rec.periodEnd,
        totalOrders: rec.totalOrders,
        totalMovements: rec.totalMovements,
        matchedCount: rec.matchedCount,
        unmatchedCount: rec.unmatchedCount,
        divergentCount: rec.divergentCount,
        expectedRevenue: Number(rec.expectedRevenue),
        actualRevenue: Number(rec.actualRevenue),
        discrepancy: Number(rec.discrepancy),
        status: rec.status,
      });
    }

    // Format currency columns
    ['I', 'J', 'K'].forEach(col => {
      summarySheet.getColumn(col).numFmt = 'R$ #,##0.00';
    });

    // Items sheet
    const itemsSheet = workbook.addWorksheet('Itens Detalhados', {
      properties: { tabColor: { argb: 'FFFF9800' } },
    });

    itemsSheet.columns = [
      { header: 'ID Item', key: 'id', width: 40 },
      { header: 'Status', key: 'status', width: 15 },
      { header: 'Tipo Match', key: 'matchType', width: 15 },
      { header: 'Valor Pedido', key: 'orderAmount', width: 15 },
      { header: 'Valor Movimento', key: 'movementAmount', width: 15 },
      { header: 'Diferença', key: 'difference', width: 15 },
      { header: 'ID Pedido ML', key: 'orderExternalId', width: 15 },
      { header: 'Título Produto', key: 'title', width: 40 },
      { header: 'ID Movimento MP', key: 'movementExternalId', width: 15 },
    ];

    // Style header
    const itemsHeader = itemsSheet.getRow(1);
    itemsHeader.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    itemsHeader.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFFF9800' },
    };

    for (const rec of reconciliations) {
      for (const item of rec.items) {
        const row = itemsSheet.addRow({
          id: item.id,
          status: item.status,
          matchType: item.matchType || '',
          orderAmount: item.orderAmount ? Number(item.orderAmount) : null,
          movementAmount: item.movementAmount ? Number(item.movementAmount) : null,
          difference: item.difference ? Number(item.difference) : null,
          orderExternalId: item.order?.externalId || '',
          title: item.order?.items[0]?.title || '',
          movementExternalId: item.movement?.externalId || '',
        });

        // Highlight divergent items
        if (item.status === 'DIVERGENT') {
          row.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FFFFEBEE' },
          };
        }
      }
    }

    // Format currency columns
    ['D', 'E', 'F'].forEach(col => {
      itemsSheet.getColumn(col).numFmt = 'R$ #,##0.00';
    });

    const buffer = await workbook.xlsx.writeBuffer();
    const totalItems = reconciliations.reduce((sum, r) => sum + r.items.length, 0);
    logger.info({ reconciliationCount: reconciliations.length, itemCount: totalItems }, 'Reconciliation exported to Excel');

    return Buffer.from(buffer);
  }

  /**
   * Export complete financial report
   */
  async exportFullReport(options: ExportOptions): Promise<Buffer> {
    logger.info(options, 'Generating full financial report');

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'ML-MP Reconciliation';
    workbook.created = new Date();
    workbook.title = 'Relatório Financeiro Completo';

    // Get all data
    const [orders, movements, reconciliations] = await Promise.all([
      prisma.mLOrder.findMany({
        where: {
          dateCreated: { gte: options.startDate, lte: options.endDate },
        },
        include: { items: true },
        orderBy: { dateCreated: 'desc' },
      }),
      prisma.mPMovement.findMany({
        where: {
          dateCreated: { gte: options.startDate, lte: options.endDate },
        },
        orderBy: { dateCreated: 'desc' },
      }),
      prisma.reconciliation.findMany({
        where: {
          periodStart: { gte: options.startDate },
          periodEnd: { lte: options.endDate },
        },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    // Dashboard sheet
    const dashSheet = workbook.addWorksheet('Dashboard', {
      properties: { tabColor: { argb: 'FF2196F3' } },
    });

    // Summary data
    const totalOrderValue = orders.reduce((sum, o) => sum + Number(o.totalAmount), 0);
    const totalShipping = orders.reduce((sum, o) => sum + Number(o.shippingCost || 0), 0);
    const totalMovementValue = movements.reduce((sum, m) => sum + Number(m.amount), 0);
    const totalMovementFees = movements.reduce((sum, m) => sum + Number(m.fee || 0), 0);

    dashSheet.addRow(['RELATÓRIO FINANCEIRO']);
    dashSheet.mergeCells('A1:D1');
    dashSheet.getCell('A1').font = { size: 18, bold: true };
    dashSheet.getCell('A1').alignment = { horizontal: 'center' };

    dashSheet.addRow([`Período: ${options.startDate.toLocaleDateString('pt-BR')} - ${options.endDate.toLocaleDateString('pt-BR')}`]);
    dashSheet.mergeCells('A2:D2');
    dashSheet.getCell('A2').alignment = { horizontal: 'center' };

    dashSheet.addRow([]);
    dashSheet.addRow(['RESUMO GERAL']);
    dashSheet.getCell('A4').font = { bold: true, size: 14 };

    dashSheet.addRow([]);
    dashSheet.addRow(['Métrica', 'Valor']);
    const metricsHeader = dashSheet.getRow(6);
    metricsHeader.font = { bold: true };

    dashSheet.addRow(['Total de Pedidos ML', orders.length]);
    dashSheet.addRow(['Valor Bruto Pedidos', totalOrderValue]);
    dashSheet.addRow(['Total Frete', totalShipping]);
    dashSheet.addRow(['Total de Movimentos MP', movements.length]);
    dashSheet.addRow(['Valor Bruto Movimentos', totalMovementValue]);
    dashSheet.addRow(['Taxas MP', totalMovementFees]);
    dashSheet.addRow(['Total Conciliações', reconciliations.length]);
    dashSheet.addRow(['Diferença Bruta', totalOrderValue - totalMovementValue]);

    // Format currency
    for (let i = 8; i <= 14; i++) {
      const cell = dashSheet.getCell(`B${i}`);
      if (typeof cell.value === 'number' && i !== 10 && i !== 13) {
        cell.numFmt = 'R$ #,##0.00';
      }
    }

    dashSheet.getColumn('A').width = 30;
    dashSheet.getColumn('B').width = 20;

    // Orders sheet
    const ordersSheet = workbook.addWorksheet('Pedidos');
    ordersSheet.columns = [
      { header: 'ID ML', key: 'externalId', width: 15 },
      { header: 'Data', key: 'dateCreated', width: 18 },
      { header: 'Status', key: 'status', width: 15 },
      { header: 'Produtos', key: 'products', width: 40 },
      { header: 'Valor Total', key: 'totalAmount', width: 15 },
      { header: 'Frete', key: 'shippingCost', width: 12 },
    ];

    ordersSheet.getRow(1).font = { bold: true };
    for (const order of orders) {
      const productTitles = order.items.map(i => i.title).join(', ');
      ordersSheet.addRow({
        externalId: order.externalId,
        dateCreated: order.dateCreated,
        status: order.status,
        products: productTitles.substring(0, 100),
        totalAmount: Number(order.totalAmount),
        shippingCost: order.shippingCost ? Number(order.shippingCost) : 0,
      });
    }

    // Movements sheet
    const movSheet = workbook.addWorksheet('Movimentos');
    movSheet.columns = [
      { header: 'ID MP', key: 'externalId', width: 15 },
      { header: 'Data', key: 'dateCreated', width: 18 },
      { header: 'Tipo', key: 'type', width: 15 },
      { header: 'Descrição', key: 'description', width: 40 },
      { header: 'Valor', key: 'amount', width: 15 },
      { header: 'Taxa', key: 'fee', width: 12 },
      { header: 'Valor Líquido', key: 'netAmount', width: 15 },
    ];

    movSheet.getRow(1).font = { bold: true };
    for (const mov of movements) {
      movSheet.addRow({
        externalId: mov.externalId,
        dateCreated: mov.dateCreated,
        type: mov.type,
        description: mov.description || '',
        amount: Number(mov.amount),
        fee: mov.fee ? Number(mov.fee) : 0,
        netAmount: mov.netAmount ? Number(mov.netAmount) : Number(mov.amount),
      });
    }

    const buffer = await workbook.xlsx.writeBuffer();
    logger.info({
      orderCount: orders.length,
      movementCount: movements.length,
      reconciliationCount: reconciliations.length,
    }, 'Full report exported');

    return Buffer.from(buffer);
  }

  /**
   * Export orders with fees breakdown to Excel
   */
  async exportOrdersWithFees(options: ExportOptions): Promise<Buffer> {
    logger.info({ startDate: options.startDate, endDate: options.endDate }, 'Exporting orders with fees to Excel');

    const orders = await prisma.mLOrder.findMany({
      where: {
        dateCreated: {
          gte: options.startDate,
          lte: options.endDate,
        },
      },
      include: {
        items: true,
        payments: true,
      },
      orderBy: { dateCreated: 'desc' },
    });

    // Get MP movements to find fees by reference (order ID)
    const movements = await prisma.mPMovement.findMany({
      where: {
        dateCreated: {
          gte: options.startDate,
          lte: options.endDate,
        },
      },
    });

    // Create a map of order ID -> MP fee
    const mpFeeByReference = new Map<string, number>();
    for (const mov of movements) {
      if (mov.fee && mov.referenceId) {
        const currentFee = mpFeeByReference.get(mov.referenceId) || 0;
        mpFeeByReference.set(mov.referenceId, currentFee + Number(mov.fee));
      }
      if (mov.fee && mov.externalReference) {
        const currentFee = mpFeeByReference.get(mov.externalReference) || 0;
        mpFeeByReference.set(mov.externalReference, currentFee + Number(mov.fee));
      }
    }

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'ML-MP Reconciliation';
    workbook.created = new Date();

    const sheet = workbook.addWorksheet('Pedidos com Taxas', {
      properties: { tabColor: { argb: 'FF00A0DC' } },
    });

    // Define columns with fees
    sheet.columns = [
      { header: 'ID Pedido', key: 'externalId', width: 18 },
      { header: 'Data', key: 'dateCreated', width: 18 },
      { header: 'Status', key: 'status', width: 12 },
      { header: 'Produto', key: 'products', width: 35 },
      { header: 'Qtd', key: 'quantity', width: 6 },
      { header: 'Valor Bruto', key: 'grossAmount', width: 14 },
      { header: 'Taxa ML', key: 'mlFee', width: 12 },
      { header: 'Taxa MP', key: 'mpFee', width: 12 },
      { header: 'Frete', key: 'shippingCost', width: 12 },
      { header: 'Valor Líquido', key: 'netAmount', width: 14 },
      { header: '% Taxas', key: 'feePercentage', width: 10 },
    ];

    // Style header row
    const headerRow = sheet.getRow(1);
    headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    headerRow.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF00A0DC' },
    };
    headerRow.alignment = { vertical: 'middle', horizontal: 'center' };

    let totalGross = 0;
    let totalMlFee = 0;
    let totalMpFee = 0;
    let totalShipping = 0;
    let totalNet = 0;

    // Add data with fees calculation
    for (const order of orders) {
      const productTitles = order.items.map(i => i.title).join(', ');
      const quantity = order.items.reduce((sum, i) => sum + i.quantity, 0);
      
      // Calculate ML fees from items (sale_fee)
      let mlFee = 0;
      for (const item of order.items) {
        if (item.saleFee) mlFee += Number(item.saleFee);
      }
      
      // Get MP fee from movements map (by order externalId)
      const mpFee = mpFeeByReference.get(order.externalId) || 0;
      
      const grossAmount = Number(order.totalAmount);
      const shippingCost = order.shippingCost ? Number(order.shippingCost) : 0;
      const netAmount = grossAmount - mlFee - mpFee;
      const feePercentage = grossAmount > 0 ? ((mlFee + mpFee) / grossAmount * 100) : 0;
      
      totalGross += grossAmount;
      totalMlFee += mlFee;
      totalMpFee += mpFee;
      totalShipping += shippingCost;
      totalNet += netAmount;

      sheet.addRow({
        externalId: order.externalId,
        dateCreated: order.dateCreated,
        status: order.status,
        products: productTitles.substring(0, 80),
        quantity,
        grossAmount,
        mlFee,
        mpFee,
        shippingCost,
        netAmount,
        feePercentage,
      });
    }

    // Format currency columns
    ['F', 'G', 'H', 'I', 'J'].forEach(col => {
      sheet.getColumn(col).numFmt = 'R$ #,##0.00';
    });
    
    // Format percentage column
    sheet.getColumn('K').numFmt = '0.00%';

    // Format date column
    sheet.getColumn('B').numFmt = 'dd/mm/yyyy hh:mm';

    // Add summary row
    sheet.addRow({});
    const summaryRow = sheet.addRow({
      externalId: 'TOTAIS',
      quantity: orders.length,
      grossAmount: totalGross,
      mlFee: totalMlFee,
      mpFee: totalMpFee,
      shippingCost: totalShipping,
      netAmount: totalNet,
      feePercentage: totalGross > 0 ? (totalMlFee + totalMpFee) / totalGross : 0,
    });
    summaryRow.font = { bold: true };
    summaryRow.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFFFE599' },
    };

    const buffer = await workbook.xlsx.writeBuffer();
    logger.info({ orderCount: orders.length }, 'Orders with fees exported to Excel');

    return Buffer.from(buffer);
  }
}

export const excelExportService = new ExcelExportService();
