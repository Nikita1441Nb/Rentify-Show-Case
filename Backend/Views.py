import json
from django.db import transaction
from django.http import JsonResponse
from django.utils import timezone
from django.views.decorators.csrf import csrf_exempt
from .models import Client, Catalog, Inventory, Rent, RentItem, Payment, SubAccount

@csrf_exempt
def desktop_auth(request):
    """
    Авторизация десктопного клиента с привязкой к HWID (Hardware ID).
    Реализует защиту лицензии от копирования на другие устройства.
    """
    if request.method != 'POST':
        return JsonResponse({'error': 'Method not allowed'}, status=405)

    try:
        data = json.loads(request.body)
        username = data.get('username')
        password = data.get('password')
        hwid = data.get('hwid')

        # Поиск субаккаунта (конкретной точки проката)
        sub = SubAccount.objects.filter(username=username).first()
        if not sub or not sub.check_password(password):
            return JsonResponse({'error': 'Invalid credentials'}, status=403)

        # Логика HWID: привязка при первом входе или проверка при последующих
        if sub.hwid and sub.hwid != hwid:
            return JsonResponse({'error': 'Device mismatch. Identity lock active.'}, status=403)
        
        if not sub.hwid:
            sub.hwid = hwid
            sub.save()

        master = sub.owner
        # Проверка глобального статуса подписки мастер-аккаунта
        if not master.is_active_subscription or (master.license_expiry and master.license_expiry < timezone.now()):
            return JsonResponse({'error': 'License expired or inactive'}, status=403)

        return JsonResponse({
            'status': 'success',
            'api_token': sub.api_token,
            'license_expiry': master.license_expiry.isoformat() if master.license_expiry else None
        })
    except Exception as e:
        return JsonResponse({'error': str(e)}, status=500)


@csrf_exempt
@transaction.atomic
def sync_all(request):
    """
    Ядро инкрементальной синхронизации. 
    Использует transaction.atomic для обеспечения целостности данных при массовой загрузке.
    Связывает локальные ID (SQLite) с серверными объектами (PostgreSQL).
    """
    auth_header = request.headers.get('Authorization')
    if not auth_header or not auth_header.startswith('Bearer '):
        return JsonResponse({'error': 'Unauthorized'}, status=401)

    token = auth_header.split(' ')[1]
    sub_account = SubAccount.objects.filter(api_token=token, is_active=True).select_related('owner').first()
    
    if not sub_account:
        return JsonResponse({'error': 'Invalid token'}, status=401)

    master_user = sub_account.owner
    data = json.loads(request.body)

    # Вспомогательная функция для маппинга дат
    def parse_dt(val):
        return val if val and val.strip() != "" else None

    try:
        # Синхронизация клиентов (Update or Create)
        for item in data.get('clients', []):
            Client.objects.update_or_create(
                owner=master_user, 
                local_sqlite_id=item.get('local_id'),
                defaults={
                    'name': item.get('name'),
                    'phone': item.get('phone'),
                    'iin': item.get('iin'),
                    'debt_amount': item.get('debt_amount', 0),
                    'rating': item.get('rating')
                }
            )

        # Синхронизация инвентаря с привязкой к родителю (Catalog)
        for item in data.get('inventory', []):
            cat_instance = Catalog.objects.filter(owner=master_user, local_sqlite_id=item.get('catalog_id')).first()
            Inventory.objects.update_or_create(
                owner=master_user, 
                local_sqlite_id=item.get('local_id'),
                defaults={
                    'catalog': cat_instance,
                    'article': item.get('article'),
                    'status': item.get('status', 'available'),
                    'next_maintenance_date': parse_dt(item.get('next_maintenance_date'))
                }
            )

        # Синхронизация аренд (обработка Many-to-One связей)
        for item in data.get('rents', []):
            client_inst = Client.objects.filter(owner=master_user, local_sqlite_id=item.get('client_id')).first()
            Rent.objects.update_or_create(
                owner=master_user, 
                local_sqlite_id=item.get('local_id'),
                defaults={
                    'client': client_inst,
                    'status': item.get('status'),
                    'total_price': float(item.get('total_price', 0)),
                    'date_start': parse_dt(item.get('date_start')),
                    'date_end': parse_dt(item.get('date_end'))
                }
            )

        return JsonResponse({'status': 'success', 'timestamp': timezone.now().isoformat()})
    
    except Exception as e:
        return JsonResponse({'status': 'error', 'message': str(e)}, status=500)
