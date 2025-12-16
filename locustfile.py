import random
import string
from locust import HttpUser, task, between

cases = [
    {"pid":"index.parquet", "info": 200, "object": 200, "meta":404},
    {
        "pid":"BLE_LTER_leachate_DOM_composition.csv", 
        "info": 200, 
        "object": 200, 
        "meta":404
    }, 
    {
        "pid":"urn:uuid:fc6798d4-9e79-4eb7-84d6-db05005cd356", 
        "info": 200, 
        "object": 200, 
        "meta":200
    },
]

class MyUser(HttpUser):
    wait_time = between(1, 3)
    host = "http://localhost:2010"
    
    def do_task(self, op):
        target = random.choice(cases)
        with self.client.get(f"/{op}/{target['pid']}", catch_response=True) as response:
            if response.status_code == target[op]:
                response.success()
            else:
                response.failure(f'Expected {target[op]} but got {response.status_code}')
        

    @task
    def info(self):
        return self.do_task("info")        
        #target = random.choice(cases)
        #with self.client.get(f"/info/{target['pid']}", catch_response=True) as response:
        #    if response.status_code == target["info"]:
        #        response.success()
        #    else:
        #        response.failure(f'Expected {target["info"]} but got {response.status_code}')

    @task
    def meta(self):
        return self.do_task("meta")

    @task
    def object(self):
        return self.do_task("object")

