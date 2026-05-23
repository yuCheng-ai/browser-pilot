const riskTerms = [
  {
    level: "high",
    reason: "目标可能触发支付或下单。",
    expressions: [/pay/i, /checkout/i, /purchase/i, /支付/, /付款/, /下单/, /购买/],
  },
  {
    level: "high",
    reason: "目标可能删除或发布数据。",
    expressions: [/delete/i, /remove/i, /publish/i, /删除/, /移除/, /发布/, /清空/],
  },
  {
    level: "medium",
    reason: "目标可能提交或审批数据。",
    expressions: [/submit/i, /approve/i, /confirm/i, /提交/, /审批/, /通过/, /确认/],
  },
];

export function getClickablePoint(box) {
  return {
    x: Math.round(box.x + box.width / 2),
    y: Math.round(box.y + box.height / 2),
  };
}

export function classifyTargetRisk(target) {
  const source = [
    target.label,
    target.text,
    target.ariaLabel,
    target.title,
    target.type,
  ]
    .filter(Boolean)
    .join(" ");

  for (const rule of riskTerms) {
    if (rule.expressions.some((expression) => expression.test(source))) {
      return {
        level: rule.level,
        reason: rule.reason,
      };
    }
  }

  return null;
}
